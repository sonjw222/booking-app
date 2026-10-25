// 수동 러너 요약: skipped ≠ PASS, "BLOCKED:" 사유는 BLOCKED로 센다(JSON 리포트 파일만 입력, 실행 없음).
import { describe, expect, it } from "vitest";
import { classifyReport, formatSummary } from "../../scripts/e2e/adminPaginationSummary.mjs";

const t = (status: string, skip?: string) => ({ status, annotations: skip ? [{ type: "skip", description: skip }] : [], results: [{ status: status === "expected" ? "passed" : status }] });
const report = (tests: ReturnType<typeof t>[]) => ({ suites: [{ title: "f.spec.ts", suites: [{ title: "d", specs: tests.map((x, i) => ({ title: `t${i}`, tests: [x] })) }] }] });

describe("classifyReport", () => {
  it("전부 통과일 때만 PASS", () => {
    expect(classifyReport(report([t("expected"), t("expected")])).overall).toBe("PASS");
  });
  it("BLOCKED 사유 skip은 BLOCKED, 그 외 skip은 SKIP — 둘 다 PASS가 아니다(INCOMPLETE)", () => {
    const c = classifyReport(report([t("expected"), t("skipped", "BLOCKED: 데이터 부족"), t("skipped", "Dedicated DEV fixture run only")]));
    expect(c.BLOCKED).toHaveLength(1); expect(c.SKIP).toHaveLength(1); expect(c.PASS).toHaveLength(1);
    expect(c.overall).toBe("INCOMPLETE");
    expect(formatSummary("ON", c)).toContain("PASS가 아닙니다");
  });
  it("실패가 있으면 FAIL, 실행된 테스트가 0개여도 PASS가 아니다", () => {
    expect(classifyReport(report([t("unexpected")])).overall).toBe("FAIL");
    expect(classifyReport(report([])).overall).toBe("INCOMPLETE");
  });
});
