/*
  NICEPAY 격리 QA "인증만(auth-only)" 모드 — 순수 함수(네트워크·DB 없음). 목적: NICEPAY v3 결제창을 열고 닫는 것까지만 검증하고, 승인(돈이 움직이는) 호출은 어떤 경로로도 나가지 않게 한다.
  왜 필요한가: 코드 상수 NICEPAY_CHECKOUT_ACTIVATED 는 main 에서 이미 true(서버 스위치 NICEPAY_CHECKOUT_ENABLED 로 막는 구조)라, 테스트 MID 로 서버 스위치만 켜면
  "인증 완료 → 서버 ReturnURL → 승인 API" 가 자동으로 이어진다. NICEPAY_ENV=sandbox 만으로는 이를 막지 못한다.
  규칙(하나라도 어긋나면 NICEPAY 설정 자체가 비활성 = fail-closed):
    · "요청됨" = NICEPAY_QA_AUTH_ONLY==="true"  또는  NICEPAY_MID 가 공용 테스트 MID(nicepay00m)  — 테스트 MID 는 어떤 환경에서도 승인하지 않는다(플래그를 깜빡해도 안전).
    · 요청되면: MID 는 공용 테스트 MID 여야 함(운영 mwhabit01m·정기결제 mwhabit02m 및 그 밖의 값 거부), NICEPAY_ENV=sandbox, 계열=v3_mid, VERCEL_ENV≠production,
      Supabase URL 이 운영 프로젝트가 아님(운영 ref 거부 + URL 필수), 복귀 주소가 운영 도메인(mwhabit.com)이 아님, 일반회원 카드결제(NEXT_PUBLIC_PG_CHECKOUT_ENABLED=true)가 켜져 있지 않음.
    · 켜진 모드: 승인·망취소·취소·환불·조회 등 NICEPAY 호스트로 나가는 모든 fetch 를 차단(guardFetch)하고, 인증 결과 ReturnURL 은 서명·금액만 확인한 뒤 승인 없이 주문을 정리한다.
  MerchantKey·MID 값은 어디에도 출력하지 않는다(문제 목록에는 항목 이름만).
*/
export const NICEPAY_PUBLIC_TEST_MID = "nicepay00m";
export const NICEPAY_FORBIDDEN_MIDS: readonly string[] = ["mwhabit01m", "mwhabit02m"];   // 운영 단건·정기결제 — QA 에서 사용 금지
export const PRODUCTION_SUPABASE_REFS: readonly string[] = ["bxntqggkfwnhcczsbqtj"];
export const PRODUCTION_HOSTS: readonly string[] = ["mwhabit.com", "www.mwhabit.com"];

type Env = Record<string, string | undefined>;
export type QaAuthOnlyEval = { requested: boolean; ok: boolean; problems: string[] };

export function evaluateQaAuthOnly(env: Env): QaAuthOnlyEval {
  const mid = (env.NICEPAY_MID ?? "").trim();
  const requested = env.NICEPAY_QA_AUTH_ONLY === "true" || mid === NICEPAY_PUBLIC_TEST_MID;
  if (!requested) return { requested: false, ok: true, problems: [] };
  const problems: string[] = [];
  if (mid !== NICEPAY_PUBLIC_TEST_MID) problems.push(NICEPAY_FORBIDDEN_MIDS.includes(mid) ? "NICEPAY_MID(운영/정기결제 MID 사용 금지)" : "NICEPAY_MID(공용 테스트 MID 만 허용)");
  if (env.NICEPAY_ENV !== "sandbox") problems.push("NICEPAY_ENV(sandbox 만 허용)");
  if (env.NICEPAY_API_FAMILY !== "v3_mid") problems.push("NICEPAY_API_FAMILY(v3_mid 만 허용)");
  if (env.VERCEL_ENV === "production") problems.push("VERCEL_ENV(production 에서는 사용 금지)");
  if (env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED === "true") problems.push("NEXT_PUBLIC_PG_CHECKOUT_ENABLED(일반회원 카드결제는 꺼져 있어야 함)");
  const sb = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().toLowerCase();
  if (!sb) problems.push("NEXT_PUBLIC_SUPABASE_URL(비운영 DB 확인 필요)");
  else if (PRODUCTION_SUPABASE_REFS.some((ref) => sb.includes(ref))) problems.push("NEXT_PUBLIC_SUPABASE_URL(운영 Supabase 접근 금지)");
  let retHost = ""; try { retHost = new URL((env.NICEPAY_RETURN_BASE_URL ?? "").trim()).hostname.toLowerCase(); } catch { /* 형식 오류는 기존 검사가 잡는다 */ }
  if (PRODUCTION_HOSTS.includes(retHost)) problems.push("NICEPAY_RETURN_BASE_URL(운영 도메인 금지)");
  return { requested: true, ok: problems.length === 0, problems };
}

export class NicepayQaBlockedError extends Error {
  readonly code = "QA_AUTH_ONLY_BLOCKED";
  constructor(host: string) { super(`QA auth-only: NICEPAY 호출 차단(${host})`); }
}
const isNicepayHost = (h: string) => h === "nicepay.co.kr" || h.endsWith(".nicepay.co.kr");

/** auth-only 모드의 fetch 래퍼: NICEPAY 호스트로 가는 요청은 네트워크에 닿기 전에 던진다(승인·망취소·취소·환불·조회 전부). 다른 호스트는 그대로. */
export function guardFetch<F extends (...args: never[]) => Promise<unknown>>(inner: F, qaAuthOnly: boolean | undefined, onBlocked?: (host: string) => void): F {
  if (!qaAuthOnly) return inner;
  return (async (...args: unknown[]) => {
    const input = args[0];
    const raw = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
    let host = ""; try { host = new URL(raw).hostname.toLowerCase(); } catch { host = "unparseable"; }
    if (host === "unparseable" || isNicepayHost(host)) { onBlocked?.(host); throw new NicepayQaBlockedError(host); }
    return inner(...(args as never[]));
  }) as unknown as F;
}
