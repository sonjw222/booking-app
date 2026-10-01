/*
  관리자 "수강권 만료일 연장"(2026-10-02) 순수 로직 — 계산/검증/문구. 화면(app/manager/members)과 테스트가 공유한다.
  서버(manager_extend_membership_expiry, add_membership_expiry_extension.sql)가 같은 규칙을 최종 강제하므로 여기 검증은 UX용이다.
  - "연장"만 가능: 새 만료일은 현재 만료일보다 뒤여야 하고, 오늘 이전이면 안 된다(이미 만료된 수강권도 오늘 이후로 연장은 가능).
  - 무제한(expires_at null)·상품(goods)은 대상이 아니다.
*/
export const EXPIRY_PERMISSION_KEY = "customer.member.pass_expiry.update";
export type ExtendMode = "days" | "date";
export const QUICK_EXTEND_DAYS = [7, 14, 30, 60] as const;
export const MAX_EXTEND_DAYS = 3650;
export const MAX_REASON_LENGTH = 200;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidYmd(s: string | null | undefined): s is string {
  const m = s ? YMD.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// "YYYY-MM-DD" + N일 (시간대 영향 없는 UTC 날짜 계산)
export function addDaysToYmd(ymd: string, n: number): string {
  const m = YMD.exec(ymd)!;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return d.toISOString().slice(0, 10);
}

export function diffDays(fromYmd: string, toYmd: string): number {
  const a = YMD.exec(fromYmd)!, b = YMD.exec(toYmd)!;
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000);
}

export const formatDotDate = (ymd: string) => ymd.replace(/-/g, ".");

export function todayKstYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// 연장 버튼을 보여줄 수 있는 보유 항목인지(수강권만, 만료일이 있는 것만). 권한은 별도(canDo)로 판단한다.
export function isExtendablePass(p: { kind: string; expiresAt: string | null }): boolean {
  return p.kind !== "goods" && !!p.expiresAt;
}

export type ExtensionPreview = { newExpiresAt: string | null; daysAdded: number | null; error: string | null };

export function previewExtension(input: {
  currentExpiresAt: string; mode: ExtendMode; days?: string | number | null; newDate?: string | null; today?: string;
}): ExtensionPreview {
  const today = input.today ?? todayKstYmd();
  const cur = input.currentExpiresAt;
  let next: string | null = null;
  if (input.mode === "days") {
    const raw = String(input.days ?? "").trim();
    if (!/^\d+$/.test(raw)) return { newExpiresAt: null, daysAdded: null, error: "연장 일수를 1 이상의 숫자로 입력해주세요" };
    const n = parseInt(raw, 10);
    if (n < 1) return { newExpiresAt: null, daysAdded: null, error: "연장 일수는 1일 이상이어야 해요" };
    if (n > MAX_EXTEND_DAYS) return { newExpiresAt: null, daysAdded: null, error: `한 번에 연장할 수 있는 일수를 넘었어요(최대 ${MAX_EXTEND_DAYS}일)` };
    next = addDaysToYmd(cur, n);
  } else {
    if (!isValidYmd(input.newDate)) return { newExpiresAt: null, daysAdded: null, error: "새 만료일을 선택해주세요" };
    next = input.newDate;
  }
  if (next <= cur) return { newExpiresAt: null, daysAdded: null, error: "새 만료일은 현재 만료일보다 뒤여야 해요. 만료일은 연장만 할 수 있어요." };
  if (next < today) return { newExpiresAt: next, daysAdded: diffDays(cur, next), error: "이미 만료된 수강권이에요. 새 만료일이 오늘 이후가 되도록 연장해주세요." };
  return { newExpiresAt: next, daysAdded: diffDays(cur, next), error: null };
}

export function extensionConfirmMessage(p: { passName: string; current: string; next: string; mode: ExtendMode; days: number | null }): string {
  const range = `${formatDotDate(p.current)} → ${formatDotDate(p.next)}`;
  return p.mode === "days" && p.days
    ? `${p.passName} 수강권의 만료일을\n${range}로\n${p.days}일 연장할까요?`
    : `${p.passName} 수강권의 만료일을\n${range}로\n연장할까요?`;
}

export const extensionSuccessMessage = (next: string) => `수강권 만료일을 ${formatDotDate(next)}까지 연장했어요.`;

// RPC 오류 → 사용자 문구(서버 메시지는 이미 한국어라 그대로, 함수가 아직 없는 환경만 안내)
export function extensionErrorMessage(e: { code?: string; message?: string }): string {
  if (e.code === "PGRST202" || e.code === "42883" || /Could not find the function/i.test(e.message ?? "")) {
    return "수강권 만료일 연장 기능이 아직 준비되지 않았어요. 잠시 후 다시 시도해주세요.";
  }
  return (e.message ?? "만료일을 연장하지 못했어요").replace(/^.*?:\s*/, "");
}
