/*
  소셜 로그인 이름 후보(2026-10-03) — provider가 "이번 로그인에서" 준 이름을 sessionStorage에 잠깐 맡겨 두었다가 ensureAccountForCurrentUser()가 한 번 꺼내 쓴다.
  기존 Apple 전용 스태시(apple_first_auth_full_name)를 일반화한 것이다. Apple 최초 인증 fullName은 세션이 생기기 "전"에 저장해야 SIGNED_IN 핸들러와의 race가 없다는 원칙을 모든 provider에 적용한다
  (Apple/Google native: signInWithIdToken 전, Naver/Kakao: verifyOtp 전).
  · sessionStorage만 사용, 일시적 데이터, 꺼내면(consume) 즉시 제거. 이름 값은 console/log/error에 절대 출력하지 않는다.
  · provider와 만료시간(10분)을 함께 저장하고, 꺼낼 때 "지금 로그인한 사용자의 provider"와 다르면 버린다 — 실패/취소로 남은 stash가 다른 로그인에 적용되지 않는다.
  · 빈 문자열/placeholder("회원", "카카오 회원", "네이버 회원" …)와 너무 긴 값은 저장하지 않는다. 저장 슬롯은 하나뿐이라 새 로그인이 이전 stash를 덮어쓴다.
  · autoSave: true면 기존 이름이 합성/미등록일 때 DB에 자동 복구해도 되는 신뢰 이름(Google/Apple/Naver), false면 입력칸 prefill 용도(Kakao nickname은 실명 보장이 없어 사용자가 확인 후 저장).
*/
export type SocialProvider = "google" | "apple" | "naver" | "kakao";
export type SocialNameCandidate = { provider: SocialProvider; name: string; autoSave: boolean };

export const SOCIAL_NAME_STASH_KEY = "social_name_candidate_v1";
export const SOCIAL_NAME_STASH_TTL_MS = 10 * 60 * 1000;
export const SOCIAL_NAME_MAX_LENGTH = 30;   // SessionWatcher 이름 입력칸 maxLength와 같다

const PLACEHOLDERS = new Set(["회원", "카카오회원", "네이버회원", "구글회원", "애플회원", "applemember", "googlemember", "navermember", "kakaomember", "user", "unknown", "null", "undefined", "(이름없음)"]);
const AUTO_SAVE: Record<SocialProvider, boolean> = { google: true, apple: true, naver: true, kakao: false };

// 공백 정리 + placeholder/빈 값/너무 긴 값 거부 → 쓸 수 있는 이름 또는 null
export function normalizeCandidateName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name || name.length > SOCIAL_NAME_MAX_LENGTH) return null;
  if (PLACEHOLDERS.has(name.replace(/\s+/g, "").toLowerCase())) return null;
  if (/@/.test(name)) return null;   // 이메일 문자열은 이름이 아니다
  return name;
}

export function isSocialProviderName(v: unknown): v is SocialProvider {
  return v === "google" || v === "apple" || v === "naver" || v === "kakao";
}

// Supabase user → 소셜 provider. 카카오/네이버는 user_metadata.provider(Edge Function이 설정), 구글/애플은 app_metadata.provider.
export function socialProviderOf(user: { app_metadata?: { provider?: string }; user_metadata?: { provider?: string } } | null | undefined): SocialProvider | null {
  const meta = user?.user_metadata?.provider;
  if (meta === "kakao" || meta === "naver") return meta;
  const app = user?.app_metadata?.provider;
  return app === "google" || app === "apple" ? app : null;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function store(): Store | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}

// 로그인 "전"에 호출한다. 유효한 이름이 아니면 아무것도 저장하지 않고(기존 stash도 지운다) false.
export function stashSocialName(provider: SocialProvider, rawName: unknown, opts?: { autoSave?: boolean; now?: number; storage?: Store | null }): boolean {
  const s = opts && "storage" in opts ? opts.storage ?? null : store();
  if (!s) return false;
  const name = normalizeCandidateName(rawName);
  try {
    if (!name) { s.removeItem(SOCIAL_NAME_STASH_KEY); return false; }
    const payload = { provider, name, autoSave: opts?.autoSave ?? AUTO_SAVE[provider], at: opts?.now ?? Date.now() };
    s.setItem(SOCIAL_NAME_STASH_KEY, JSON.stringify(payload));
    return true;
  } catch { return false; }
}

// 로그인 실패/취소 시 호출(오염 방지)
export function clearSocialNameStash(storage?: Store | null): void {
  const s = storage === undefined ? store() : storage;
  try { s?.removeItem(SOCIAL_NAME_STASH_KEY); } catch { /* 무시 */ }
}

// ensureAccountForCurrentUser가 한 번만 호출. 항상 stash를 제거하고, 현재 로그인 provider와 같고 만료 전이고 유효한 이름일 때만 후보를 돌려준다.
export function consumeSocialNameCandidate(currentProvider: SocialProvider | null, opts?: { now?: number; storage?: Store | null }): SocialNameCandidate | null {
  const s = opts && "storage" in opts ? opts.storage ?? null : store();
  if (!s) return null;
  let raw: string | null = null;
  try { raw = s.getItem(SOCIAL_NAME_STASH_KEY); s.removeItem(SOCIAL_NAME_STASH_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!isSocialProviderName(p?.provider) || p.provider !== currentProvider) return null;   // 다른 provider 로그인에는 쓰지 않는다
    if (typeof p.at !== "number" || (opts?.now ?? Date.now()) - p.at > SOCIAL_NAME_STASH_TTL_MS || p.at > (opts?.now ?? Date.now()) + 60_000) return null;
    const name = normalizeCandidateName(p.name);
    if (!name) return null;
    return { provider: p.provider, name, autoSave: p.autoSave === true && AUTO_SAVE[p.provider as SocialProvider] };   // autoSave는 provider 정책을 넘을 수 없다(카카오는 항상 false)
  } catch { return null; }
}

// stash가 없을 때의 보조 후보: Supabase user_metadata에 이미 실린 provider 이름. 카카오 nickname은 prefill 전용, 애플은 메타에 보통 없다.
export function metadataNameCandidate(user: { app_metadata?: { provider?: string }; user_metadata?: Record<string, any> } | null | undefined): SocialNameCandidate | null {
  const provider = socialProviderOf(user as any);
  if (!provider) return null;
  const m = user?.user_metadata ?? {};
  const name = normalizeCandidateName(m.full_name) ?? normalizeCandidateName(m.name) ?? normalizeCandidateName(m.nickname);
  return name ? { provider, name, autoSave: AUTO_SAVE[provider] } : null;
}
