/* 예약 제한 숫자 설정(일일 예약 횟수 / 프라이빗 동시 수업 개수)의 표시·저장 일치 (감사 F06·F12).
   원인(확정): 토글만 켜면 화면은 `값 ?? 1`로 1을 보여 주지만 실제 저장값은 NULL이었다. 서버(reserve_with_membership)는
   enabled=true 이면서 숫자가 NULL이 아닐 때만 제한하므로, 화면 1/실제 NULL = 사실상 무제한이었다.
   수정: ON 전환 시 유효한 기본값을 상태·저장값에 실제로 넣고, ON 상태의 빈 값·0·소수·잘못된 숫자는 저장 전에 거부한다.
   서버도 같은 규칙을 트리거로 강제한다(fix_center_limit_settings_normalize_20261022.sql) — 조용한 무제한이 아니라 명시적 오류. */
import type { CenterSettings } from "./settings";

export const DEFAULT_LIMIT = 1;
export const MAX_LIMIT = 99;

export type LimitKey = "dailyBookLimit" | "privateMaxConcurrent";
const ENABLED_KEY: Record<LimitKey, "dailyBookLimitEnabled" | "privateMaxConcurrentEnabled"> = { dailyBookLimit: "dailyBookLimitEnabled", privateMaxConcurrent: "privateMaxConcurrentEnabled" };
export const LIMIT_LABEL: Record<LimitKey, string> = { dailyBookLimit: "일일 예약 횟수 제한", privateMaxConcurrent: "프라이빗 동시 수업 제한" };

export function isValidLimit(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_LIMIT;
}

/** 토글을 바꿀 때의 다음 상태. ON이면 유효한 숫자를 반드시 갖게 한다(화면 표시값 = 저장값). OFF는 입력해 둔 숫자를 보존한다. */
export function toggleLimit(s: CenterSettings, key: LimitKey, on: boolean): CenterSettings {
  const enabledKey = ENABLED_KEY[key];
  const current = s[key];
  return { ...s, [enabledKey]: on, [key]: on && !isValidLimit(current) ? DEFAULT_LIMIT : current };
}

/** 저장 전 검증. 문제가 있으면 사용자에게 보여 줄 메시지, 없으면 null. */
export function validateLimits(s: CenterSettings): string | null {
  for (const key of Object.keys(ENABLED_KEY) as LimitKey[]) {
    if (s[ENABLED_KEY[key]] && !isValidLimit(s[key])) return `${LIMIT_LABEL[key]}을 켜려면 1~${MAX_LIMIT} 사이의 숫자가 필요해요`;
  }
  return null;
}

/** 서버 트리거가 거부한 오류를 사용자 문구로(없으면 null). */
export function limitErrorMessage(message: string | undefined): string | null {
  if (!message) return null;
  if (/하루 예약 횟수|일일 예약 횟수 제한을 켜려면/.test(message)) return `${LIMIT_LABEL.dailyBookLimit}을 켜려면 1~${MAX_LIMIT} 사이의 숫자가 필요해요`;
  if (/프라이빗 동시 수업 개수|프라이빗 동시 수업 제한을 켜려면/.test(message)) return `${LIMIT_LABEL.privateMaxConcurrent}을 켜려면 1~${MAX_LIMIT} 사이의 숫자가 필요해요`;
  return null;
}
