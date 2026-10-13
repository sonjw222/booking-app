/*
  내 예약 조회 실패 시 빈 목록처럼 보이지 않고 "다시 시도" 버튼이 있는 오류 화면을 보여주는지 검증(Issue #212).
  이 저장소의 다른 UI 계약 테스트처럼 소스 계약으로 확인한다(실제 브라우저 검증은 E2E #211 통합 브랜치에서).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "../..", "app/my-reservations/page.tsx"), "utf-8");

describe("내 예약 오류/재시도 UX", () => {
  it("오류 상태를 빈 목록보다 먼저 분기하고 role=alert + 다시 시도 button을 제공한다", () => {
    const errorIdx = src.indexOf(": error ? (");
    const emptyIdx = src.indexOf("shown.length === 0");
    expect(errorIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeLessThan(emptyIdx);
    expect(src).toContain('role="alert"');
    expect(src).toMatch(/<button type="button"[^>]*onClick=\{\(\) => load\(\)\}>다시 시도<\/button>/);
  });

  it("오래된 응답/화면 이탈 후 상태 갱신을 막고 성공 시 오류를 지운다", () => {
    expect(src).toContain("requestSeqRef");
    expect(src).toContain("mountedRef.current");
    expect(src).toMatch(/setHistory\(data\);\s*setError\(null\);/);
  });

  it("정상 빈 목록 안내와 app resume 재조회는 유지한다", () => {
    expect(src).toContain("예정된 예약이 없어요");
    expect(src).toContain("useResumeRefresh(() => load({ background: true }))");
  });
});
