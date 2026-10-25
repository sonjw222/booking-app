import { describe, expect, it } from "vitest";
import { balancedCategoryColumns } from "../../lib/categoryGrid";

describe("V07 데스크톱 종목 열 수", () => {
  it("한 줄에 8칸이 들어가는 폭(1024px 뷰포트의 본문 폭 ≈875px)에서 9개는 5+4로 나뉘어 한 개만 남지 않는다", () => {
    const cols = balancedCategoryColumns(9, 875);
    expect(cols).toBe(5);
    expect(Math.ceil(9 / cols)).toBe(2);
    expect(9 - cols).toBeGreaterThanOrEqual(cols - 1);      // 둘째 줄이 첫 줄보다 최대 1칸 적음
  });
  it("8개는 8열(한 줄), 더 넓으면 9개도 한 줄", () => {
    expect(balancedCategoryColumns(8, 875)).toBe(8);
    expect(balancedCategoryColumns(9, 1200)).toBe(9);
  });
  it("줄 수를 늘리지 않고 고르게: 17개/8칸 → 3줄(6·6·5), 10개 → 5+5", () => {
    expect(balancedCategoryColumns(17, 875)).toBe(6);
    expect(balancedCategoryColumns(10, 875)).toBe(5);
  });
  it("좁은 폭·비정상 입력", () => {
    expect(balancedCategoryColumns(9, 300)).toBe(2);        // 한 줄에 2칸
    expect(balancedCategoryColumns(0, 875)).toBe(1);
    expect(balancedCategoryColumns(5, 0)).toBeGreaterThanOrEqual(1);
  });
  it("어떤 입력이든 마지막 줄이 첫 줄보다 최대 (줄 수-1)칸만 적다(고립 방지)", () => {
    for (let n = 1; n <= 30; n++) for (const w of [320, 640, 768, 860, 1024, 1440]) {
      const c = balancedCategoryColumns(n, w); const rows = Math.ceil(n / c); const last = n - c * (rows - 1);
      expect(last).toBeGreaterThanOrEqual(1);
      if (rows > 1) expect(c - last).toBeLessThan(rows);
    }
  });
});
