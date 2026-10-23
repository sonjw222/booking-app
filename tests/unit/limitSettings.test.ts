import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../lib/settings";
import { DEFAULT_LIMIT, isValidLimit, limitErrorMessage, toggleLimit, validateLimits } from "../../lib/limitSettings";

describe("F06/F12 — 제한 숫자의 표시값 = 저장값", () => {
  it("OFF/NULL에서 토글만 켜면 유효한 기본값(1)이 실제 상태에 들어간다", () => {
    const next = toggleLimit(DEFAULT_SETTINGS, "dailyBookLimit", true);
    expect(next.dailyBookLimitEnabled).toBe(true);
    expect(next.dailyBookLimit).toBe(DEFAULT_LIMIT);
    expect(validateLimits(next)).toBeNull();
    const priv = toggleLimit(DEFAULT_SETTINGS, "privateMaxConcurrent", true);
    expect(priv).toMatchObject({ privateMaxConcurrentEnabled: true, privateMaxConcurrent: 1 });
  });
  it("이미 유효한 숫자가 있으면 덮어쓰지 않고, OFF로 꺼도 입력해 둔 숫자를 보존한다", () => {
    const on = toggleLimit({ ...DEFAULT_SETTINGS, dailyBookLimit: 2 }, "dailyBookLimit", true);
    expect(on.dailyBookLimit).toBe(2);
    const off = toggleLimit(on, "dailyBookLimit", false);
    expect(off).toMatchObject({ dailyBookLimitEnabled: false, dailyBookLimit: 2 });
  });
  it("ON 상태의 NULL·0·음수·소수·범위 초과는 저장 전에 거부한다", () => {
    for (const bad of [null, 0, -1, 1.5, 100, Number.NaN]) {
      expect(validateLimits({ ...DEFAULT_SETTINGS, dailyBookLimitEnabled: true, dailyBookLimit: bad as number | null })).toMatch(/일일 예약 횟수 제한/);
      expect(validateLimits({ ...DEFAULT_SETTINGS, privateMaxConcurrentEnabled: true, privateMaxConcurrent: bad as number | null })).toMatch(/프라이빗 동시 수업 제한/);
    }
  });
  it("OFF 상태는 숫자가 NULL이어도 통과(기존 정상 자료)", () => { expect(validateLimits(DEFAULT_SETTINGS)).toBeNull(); });
  it("경계: 1과 99는 유효", () => { expect(isValidLimit(1)).toBe(true); expect(isValidLimit(99)).toBe(true); expect(isValidLimit(0)).toBe(false); });
  it("서버 트리거 오류를 사용자 문구로", () => {
    expect(limitErrorMessage("일일 예약 횟수 제한을 켜려면 1~99 사이의 숫자가 필요해요")).toMatch(/일일 예약 횟수 제한/);
    expect(limitErrorMessage("프라이빗 동시 수업 제한을 켜려면 1~99 사이의 숫자가 필요해요")).toMatch(/프라이빗/);
    expect(limitErrorMessage("다른 오류")).toBeNull();
  });
});
