// 의도적으로 jsdom 환경 지정을 하지 않는다 — vitest.config.ts의 기본값인
// environment: "node" 그대로 실행해, DOM이 없는 환경에서 sanitizeRichText()가
// 이전처럼 알 수 없는 TypeError("... is not a function")를 던지는 대신
// 명확하고 실행 가능한 에러 메시지를 던지는지 검증한다.
import { describe, it, expect } from "vitest";
import { sanitizeRichText } from "../../lib/security";

describe("sanitizeRichText in a plain Node (no window) environment", () => {
  it("throws a clear, actionable error instead of a cryptic TypeError", () => {
    expect(typeof window).toBe("undefined");
    expect(() => sanitizeRichText("<b>hi</b>")).toThrow(
      /브라우저 또는 DOM|window\/document/
    );
  });
});
