import { describe, it, expect } from "vitest";
import { classify, formatReport, maskText, maskUrlPath, matchesRule, type KnownRule, type RawEvent } from "../rls-real/errorCollector";

const ev = (o: Partial<RawEvent> & Pick<RawEvent, "kind">): RawEvent => ({ path: "", text: "", where: "/x @390", ...o });
const REALTIME: KnownRule = { id: "realtime-ws", cause: "격리 프록시에 Realtime 없음", kind: ["console", "requestfailed"], path: /^\/realtime\/v1\/websocket$/ };
const MISSING: KnownRule = { id: "missing-table", cause: "격리 DB 에 없는 객체", kind: ["http", "console"], status: 404, path: /^\/rest\/v1\/orders_verified$/ };

describe("Q02 마스킹", () => {
  it("JWT·Bearer·이메일·토큰 쿼리·필터 값을 가린다", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123";
    const out = maskText(`GET https://x.test/rest/v1/profiles?select=id,name&email=eq.a@b.com&apikey=${jwt} Bearer ${jwt} user a@b.com`);
    expect(out).not.toContain(jwt); expect(out).not.toContain("a@b.com");
    expect(out).toContain("select=id,name"); expect(out).toContain("apikey=<redacted>");
  });
  it("URL 은 경로 + 쿼리 키만 남기고 필터 값은 가린다", () => {
    expect(maskUrlPath("http://h/rest/v1/reservations?profile_id=eq.11111111-aaaa&select=id&access_token=zzz")).toBe("/rest/v1/reservations?profile_id=…&select=id&access_token=<redacted>");
  });
});

describe("Q02 분류: 일반 문자열/RPC 라는 이유만으로 무시하지 않는다", () => {
  it("알려진 규칙은 종류·상태·경로가 모두 맞을 때만 매칭", () => {
    expect(matchesRule(ev({ kind: "http", status: 404, path: "/rest/v1/orders_verified?select=id" }), MISSING)).toBe(true);
    expect(matchesRule(ev({ kind: "http", status: 500, path: "/rest/v1/orders_verified" }), MISSING)).toBe(false);   // 상태 다름 → 예상 밖
    expect(matchesRule(ev({ kind: "http", status: 404, path: "/rest/v1/orders_verified_v2" }), MISSING)).toBe(false); // 비슷한 경로
    expect(matchesRule(ev({ kind: "http", status: 404, path: "/rest/v1/rpc/orders_verified" }), MISSING)).toBe(false);
    expect(matchesRule(ev({ kind: "pageerror", status: 404, path: "/rest/v1/orders_verified" }), MISSING)).toBe(false); // 종류 다름
  });
  it("API 500·403·스크립트/이미지 로드 실패·pageerror 는 규칙이 없으면 전부 예상 밖", () => {
    const events = [
      ev({ kind: "http", status: 500, path: "/rest/v1/rpc/class_revenue_for_date", text: "500 fetch" }),
      ev({ kind: "http", status: 403, path: "/rest/v1/reservations", text: "403 fetch" }),
      ev({ kind: "requestfailed", path: "/_next/static/chunks/app.js", text: "net::ERR_FAILED" }),
      ev({ kind: "http", status: 404, path: "/img/hero.png", text: "404 image" }),
      ev({ kind: "console", path: "/rest/v1/rpc/x", text: "Failed to load resource: the server responded with a status of 500" }),
      ev({ kind: "pageerror", text: "TypeError: x is undefined" }),
    ];
    const c = classify(events, [REALTIME, MISSING]);
    expect(c.raw).toBe(6); expect(c.known).toBe(0); expect(c.unexpected).toHaveLength(6);
  });
  it("알려진 격리 환경 오류는 따로 세고, 비슷하지만 다른 실제 오류는 통과하지 못한다", () => {
    const events = [
      ev({ kind: "console", path: "/realtime/v1/websocket", text: "WebSocket connection to 'ws://x/realtime/v1/websocket' failed" }),
      ev({ kind: "requestfailed", path: "/realtime/v1/websocket", text: "net::ERR_CONNECTION_REFUSED" }),
      ev({ kind: "http", status: 404, path: "/rest/v1/orders_verified" }),
      ev({ kind: "console", path: "/other/websocket", text: "WebSocket connection to 'ws://x/other' failed" }), // 다른 WebSocket → 예상 밖
      ev({ kind: "http", status: 403, path: "/rest/v1/orders_verified" }), // 대상은 같지만 상태 변경 → 예상 밖
    ];
    const c = classify(events, [REALTIME, MISSING]);
    expect(c.known).toBe(3); expect(c.unexpected).toHaveLength(2);
    expect(c.knownByRule["realtime-ws"].count).toBe(2); expect(c.knownByRule["missing-table"].count).toBe(1);
    expect(c.unexpected.map((e) => e.path).sort()).toEqual(["/other/websocket", "/rest/v1/orders_verified"]);
  });
  it("보고서는 raw/알려진/예상 밖 건수와 원인·대상을 정확히 보여준다", () => {
    const c = classify([ev({ kind: "console", path: "/realtime/v1/websocket", text: "ws failed" }), ev({ kind: "pageerror", text: "boom" })], [REALTIME]);
    const r = formatReport(c, "라이트 회원");
    expect(r).toContain("raw 2"); expect(r).toContain("알려진 격리환경 1"); expect(r).toContain("예상 밖 1");
    expect(r).toContain("알려진[realtime-ws] ×1"); expect(r).toContain("격리 프록시에 Realtime 없음"); expect(r).toContain("boom");
  });
});
