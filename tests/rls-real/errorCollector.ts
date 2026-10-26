/*
  시각 QA 스윕의 오류 수집·분류(Q02).

  이전에는 콘솔 error 중 "Failed to load resource" 전체, 경로에 /rest/v1/ 또는 /rpc/ 가 들어간 모든 것, 모든 WebSocket 메시지를
  무시해 "콘솔 error 0"이 raw 0 이 아니었다. 이제:
   1. raw: console error · pageerror · HTTP 4xx/5xx 응답 · requestfailed 를 따로, 가리지 않고 전부 기록한다(토큰·계정·민감 쿼리는 마스킹).
   2. known: 격리 환경에서 원인을 확인한 "정확한 종류+상태+경로+원인"만 규칙으로 선언하고 규칙별로 센다. 일반 문자열/RPC 라는 이유만으로는 무시하지 않는다.
   3. unexpected: 어느 규칙에도 안 맞는 것 — 실패로 보고한다. 규칙의 대상이 바뀌면(상태 코드·경로 변경) 자동으로 unexpected 가 된다.
*/
import type { Page } from "@playwright/test";

export type EventKind = "console" | "pageerror" | "http" | "requestfailed";
export type RawEvent = { kind: EventKind; status?: number; code?: string; method?: string; path: string; text: string; where: string };

const SENSITIVE_QS = /^(token|access_token|refresh_token|apikey|api_key|key|code|secret|password|email|phone|jwt|authorization)$/i;
const SHAPE_QS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

/** 텍스트 안의 자격 증명·계정 정보를 가린다(JWT, Bearer, 이메일, key=value 형태의 비밀). */
export function maskText(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{0,}/g, "<jwt>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\b(token|access_token|refresh_token|apikey|api_key|password|secret)=([^&\s'")]+)/gi, "$1=<redacted>")
    .replace(/(https?:\/\/[^\s'"?)]+)\?([^\s'")]+)/g, (_m, base: string, qs: string) => `${base}?${maskQuery(qs)}`);
}
function maskQuery(qs: string): string {
  return qs.split("&").map((kv) => {
    const [k, ...v] = kv.split("="); const val = v.join("=");
    if (SENSITIVE_QS.test(k)) return `${k}=<redacted>`;
    if (SHAPE_QS.has(k)) return `${k}=${val.slice(0, 60)}`;
    return `${k}=…`; // 필터 값(회원 id·검색어 등)은 가린다
  }).join("&");
}
/** URL → pathname(쿼리는 키만, 값은 가림). 파싱 실패 시 마스킹한 원문. */
export function maskUrlPath(u: string): string {
  try { const x = new URL(u); return x.pathname + (x.search ? `?${maskQuery(x.search.slice(1))}` : ""); }
  catch { return maskText(u).slice(0, 160); }
}
const pathOnly = (p: string) => p.split("?")[0];

export type Collector = { events: RawEvent[]; setWhere(w: string): void; flush(): Promise<void> };

/** page 에 리스너를 붙여 raw 이벤트를 전부 기록한다. 필터링은 하지 않는다. */
export function attachCollector(page: Page, initialWhere = ""): Collector {
  const events: RawEvent[] = []; let where = initialWhere; const pending: Promise<void>[] = [];
  const push = (e: Omit<RawEvent, "where">) => events.push({ ...e, where });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const loc = m.location()?.url; const text = maskText(m.text()).slice(0, 240);
    const st = text.match(/status of (\d{3})/);
    push({ kind: "console", status: st ? Number(st[1]) : undefined, path: loc ? maskUrlPath(loc) : "", text });
  });
  page.on("pageerror", (e) => push({ kind: "pageerror", path: "", text: maskText(String(e.message)).slice(0, 240) }));
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const base = { kind: "http" as const, status: r.status(), method: r.request().method(), path: maskUrlPath(r.url()), text: `${r.status()} ${r.request().resourceType()}` };
    const w = where; // 응답 본문을 기다리는 사이 where 가 바뀌어도 발생 시점의 화면으로 기록한다
    pending.push((async () => {
      let code: string | undefined;
      try { const j = await r.json(); if (j && typeof j.code === "string") code = j.code; } catch { /* JSON 아님 */ }
      events.push({ ...base, code, where: w });
    })());
  });
  page.on("requestfailed", (r) => push({ kind: "requestfailed", method: r.method(), path: maskUrlPath(r.url()), text: maskText(r.failure()?.errorText ?? "failed").slice(0, 120) }));
  const flush = async () => {
    await Promise.all(pending.splice(0));
    // 콘솔의 "Failed to load resource" 는 같은 요청의 HTTP 응답과 쌍이다 — 같은 경로·상태의 응답 오류 코드를 복사해 같은 규칙으로 분류한다(일반 문자열이라는 이유로 무시하지 않음).
    for (const e of events) {
      if (e.kind === "console" && e.status && !e.code) e.code = events.find((h) => h.kind === "http" && h.status === e.status && h.path === e.path && h.code)?.code;
    }
  };
  return { events, setWhere: (w) => { where = w; }, flush };
}

/** 격리 환경에서 원인을 확인한 알려진 오류. kind·status·path(정규식, 앵커 필수)·원인을 모두 지정한다. */
export type KnownRule = { id: string; cause: string; kind: EventKind[]; status?: number; code?: string; method?: string; path: RegExp; text?: RegExp };

export function matchesRule(e: RawEvent, r: KnownRule): boolean {
  if (!r.kind.includes(e.kind)) return false;
  if (r.status !== undefined && e.status !== r.status) return false;
  if (r.code !== undefined && e.code !== r.code) return false;
  if (r.method !== undefined && e.method !== r.method) return false;
  if (!r.path.test(pathOnly(e.path))) return false;
  if (r.text && !r.text.test(e.text)) return false;
  return true;
}

export type Classified = {
  raw: number; known: number; unexpected: RawEvent[];
  byKind: Record<EventKind, number>;
  knownByRule: Record<string, { cause: string; count: number; targets: string[] }>;
};
export function classify(events: RawEvent[], rules: KnownRule[]): Classified {
  const byKind: Record<EventKind, number> = { console: 0, pageerror: 0, http: 0, requestfailed: 0 };
  const knownByRule: Classified["knownByRule"] = {}; const unexpected: RawEvent[] = []; let known = 0;
  for (const e of events) {
    byKind[e.kind]++;
    const rule = rules.find((r) => matchesRule(e, r));
    if (rule) { known++; const k = (knownByRule[rule.id] ??= { cause: rule.cause, count: 0, targets: [] }); k.count++; if (!k.targets.includes(e.path)) k.targets.push(e.path); }
    else unexpected.push(e);
  }
  return { raw: events.length, known, unexpected, byKind, knownByRule };
}
export const describeEvent = (e: RawEvent) => `[${e.kind}${e.status ? ` ${e.status}` : ""}${e.method ? ` ${e.method}` : ""}] ${e.where || "-"} → ${e.path || "-"} :: ${e.text}`;

export function formatReport(c: Classified, label: string): string {
  const lines = [`${label}: raw ${c.raw} (console ${c.byKind.console} · pageerror ${c.byKind.pageerror} · http ${c.byKind.http} · requestfailed ${c.byKind.requestfailed}) = 알려진 격리환경 ${c.known} + 예상 밖 ${c.unexpected.length}`];
  for (const [id, k] of Object.entries(c.knownByRule)) lines.push(`  알려진[${id}] ×${k.count} — ${k.cause} (대상 ${k.targets.slice(0, 3).join(", ")}${k.targets.length > 3 ? ` 외 ${k.targets.length - 3}` : ""})`);
  const uniq = [...new Map(c.unexpected.map((e) => [`${e.kind}|${e.status}|${e.path}|${e.text}`, e])).values()];
  for (const e of uniq.slice(0, 20)) lines.push(`  예상 밖: ${describeEvent(e)}`);
  return lines.join("\n");
}

/* ---------- 화면 준비·화면 종류 판정 ---------- */
export const LOADING_SELECTOR = ".loading-skeleton, .loading-wrap, .route-loading, .skeleton-shimmer, [aria-busy='true']";
export const ERROR_UI_RE = /불러오지 못했|오류가 발생했/;

/** 로딩 표시가 사라질 때까지(= 데이터 로드 완료 또는 정상 빈 상태) 기다린다. 끝나지 않으면 false. */
export async function waitForSettled(page: Page, timeoutMs = 12_000): Promise<boolean> {
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
    await page.waitForFunction((sel) => !document.querySelector(sel) && document.readyState === "complete", LOADING_SELECTOR, { timeout: timeoutMs });
    return true;
  } catch { return false; }
}
export async function hasErrorUi(page: Page): Promise<string | null> {
  const t = await page.evaluate(() => document.body?.innerText ?? "");
  const m = t.match(ERROR_UI_RE); return m ? m[0] : null;
}
