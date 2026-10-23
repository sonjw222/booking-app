import { describe, expect, it } from "vitest";
describe("F16 — 정기권 매출 표시 방식 문구(서버 필드 의미와 일치)", () => {
  it("usage_split(기본/모름): 정기권 줄은 '이용 횟수로 분배', 구매일 전액이라고 하지 않는다", async () => {
    const { revenueBreakdownLabels } = await import("../../lib/classRevenue");
    for (const m of ["usage_split", null, undefined] as const) {
      const l = revenueBreakdownLabels(m);
      expect(l.periodLabel).toBe("정기권(이용 횟수로 분배)");
      expect(l.classLabel).toBe("수업(횟수제)");
      expect(l.note).toContain("이용한 수업 횟수");
      expect(l.periodLabel + l.note).not.toContain("구매일 전액");
    }
  });
  it("purchase_date_full: 정기권(구매일 전액) 줄과 결제일 표시 설명", async () => {
    const { revenueBreakdownLabels } = await import("../../lib/classRevenue");
    const l = revenueBreakdownLabels("purchase_date_full");
    expect(l.periodLabel).toBe("정기권(구매일 전액)");
    expect(l.note).toContain("결제한 날");
  });
});
