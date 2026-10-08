import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 관리자 수업 편집 시트의 "예약 가능 수강권" 안내는 서버 정책과 같아야 한다.
// 정책(fix_reservation_integrity_20261003.sql [F2]): 'selected'로 직접 지정한 수강권도 수강권 자체의 요일/시간 예약조건을 건너뛰지 않는다(지정 AND 예약조건).
// 예전 안내("직접 지정이 우선 / 조건과 무관하게 사용 가능")는 이 정책 이전의 override 동작이라 거짓 안내가 된다.
const page = readFileSync("app/manager/classes/page.tsx", "utf8").replace(/\s+/g, " ");

describe("관리자 수업 편집 — 직접 지정 수강권 안내", () => {
  it("예약조건이 계속 적용된다고 안내한다", () => {
    expect(page).toContain("직접 지정한 수강권이라도 그 수강권 자체의 요일/시간 예약조건(수강권 관리)은 이것과 별개로 계속 적용돼요.");
    expect(page).toContain("수강권은 이 수업에 직접 지정했지만, 수강권 자체의 예약조건과 이 수업이 맞지 않아 이 수업에서는 쓸 수 없어요:");
  });
  it("'조건과 무관하게 사용 가능 / 직접 지정이 우선' 취지의 옛 문구가 없다", () => {
    for (const stale of ["조건과 무관하게", "직접 지정이 우선", "직접 지정이 예약조건보다 우선", "원래 조건:", "원래 예약조건이 있지만"]) expect(page, stale).not.toContain(stale);
  });
  it("안내 훅(클래스)과 모드별 경고/안내 구조는 그대로다", () => {
    expect(page).toContain("schedule-rule-override-note");
    expect(page).toContain("schedule-rule-warning");
  });
});
