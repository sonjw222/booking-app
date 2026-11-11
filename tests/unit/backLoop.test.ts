// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeReturnSteps, prepareHistoryForPayment, REVIEW_HISTORY_KEY } from "../../lib/payments/reviewHistory";
import { __resetAppHistoryForTests, hasInAppBackTarget, noteReplaceNavigation, trackAppHistory } from "../../lib/appHistory";
import { navigateBack } from "../../lib/backPolicy";
import { readFileSync } from "node:fs";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rec = (anchor: number, at = 1000) => JSON.stringify({ anchor, at });

describe("computeReturnSteps — 결제창 종료 후 anchor entry 로 돌아갈 뒤로 가기 횟수", () => {
  it("정상: 마지막 인덱스 − anchor", () => { expect(computeReturnSteps(rec(3), 7, 2000)).toBe(3); expect(computeReturnSteps(rec(3), 5, 2000)).toBe(1); });
  it.each([
    ["기록 없음", null, 7], ["깨진 JSON", "{x", 7], ["anchor 가 숫자 아님", JSON.stringify({ anchor: "3", at: 1000 }), 7], ["음수 anchor", rec(-1), 7], ["소수 anchor", rec(2.5), 7],
    ["이동 없음(n=0)", rec(6), 7], ["anchor 가 길이보다 큼(n<0)", rec(9), 7], ["상한 초과(비정상)", rec(1), 30], ["브라우저 길이 한도 근처", rec(1), 50],
  ])("폴백(null): %s", (_n, raw, len) => { expect(computeReturnSteps(raw as string | null, len as number, 2000)).toBeNull(); });
  it("만료·시계 역행은 폴백", () => { expect(computeReturnSteps(rec(3, 1000), 7, 1000 + 31 * 60 * 1000)).toBeNull(); expect(computeReturnSteps(rec(3, 5000), 7, 1000)).toBeNull(); });
});

describe("prepareHistoryForPayment — 실제 history(jsdom)", () => {
  beforeEach(() => { sessionStorage.clear(); });
  it("열기 직전 entry 를 anchor 로 기록하고 주소는 그대로, 결제창 중 entry 가 쌓이면 그만큼 되돌아가는 횟수가 된다", async () => {
    history.pushState({}, "", "/center/x"); history.pushState({}, "", "/checkout?center=x&product=y");
    const before = history.length, href = location.href;
    expect(await prepareHistoryForPayment(window, 1000, 800)).toBe(true);
    expect(location.href).toBe(href);                                  // 되돌아와 같은 결제 화면에 서 있다
    const rawAnchor = sessionStorage.getItem(REVIEW_HISTORY_KEY)!;
    expect(JSON.parse(rawAnchor).anchor).toBe(before - 1);             // 결제 화면 entry 의 인덱스
    history.pushState({}, "", "/nicepay-1"); history.pushState({}, "", "/nicepay-2"); history.pushState({}, "", "/result");   // 결제창 안 이동 3 entry
    expect(computeReturnSteps(rawAnchor, history.length, 2000)).toBe(3);
  });
  it("결제창을 여러 번 열고 닫아도(오래된 forward entry 가 남아 있어도) 같은 횟수로 계산된다", async () => {
    history.pushState({}, "", "/checkout?a=1");
    const steps: number[] = [];
    for (let i = 0; i < 3; i++) {
      await prepareHistoryForPayment(window, 1000 + i, 800);
      const raw = sessionStorage.getItem(REVIEW_HISTORY_KEY)!;
      history.pushState({}, "", "/nicepay-a"); history.pushState({}, "", "/result");
      steps.push(computeReturnSteps(raw, history.length, 2000)!);
      history.go(-steps[i]); await wait(50);                           // '결제 화면으로 돌아가기' = history.go(-n) — forward entry 는 남는다
      expect(location.pathname + location.search).toBe("/checkout?a=1");
    }
    expect(new Set(steps).size).toBe(1);
  });
});

describe("앱 안 이동 기록 — 폴백 대체 이동", () => {
  beforeEach(() => { __resetAppHistoryForTests(); });
  it("push 이동이면 되돌아갈 앱 안 화면이 있고, 폴백 replace 이동이면 없다(딥링크 왕복 방지)", () => {
    trackAppHistory("/checkout"); trackAppHistory("/center/x"); expect(hasInAppBackTarget()).toBe(true);
    __resetAppHistoryForTests(); trackAppHistory("/checkout"); noteReplaceNavigation(); trackAppHistory("/center/x");
    expect(hasInAppBackTarget()).toBe(false);
  });
});

describe("navigateBack — back / replace / push 선택", () => {
  const mk = () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() });
  beforeEach(() => { __resetAppHistoryForTests(); sessionStorage.clear(); });
  it("앱 안 이동 이력이 없으면(딥링크) 폴백을 replace — push 로 새 entry 를 만들지 않는다", () => {
    const r = mk(); trackAppHistory("/checkout"); navigateBack(r, { fallbackHref: "/center/x" });
    expect(r.replace).toHaveBeenCalledWith("/center/x"); expect(r.push).not.toHaveBeenCalled(); expect(r.back).not.toHaveBeenCalled();
  });
  it("이력이 있으면 router.back", () => { const r = mk(); trackAppHistory("/a"); trackAppHistory("/b"); navigateBack(r, { fallbackHref: "/a" }); expect(r.back).toHaveBeenCalled(); expect(r.replace).not.toHaveBeenCalled(); });
  it("preferFallback(예약 복귀)은 기존대로 push", () => { const r = mk(); trackAppHistory("/a"); trackAppHistory("/b"); navigateBack(r, { fallbackHref: "/reservation", preferFallback: true }); expect(r.push).toHaveBeenCalledWith("/reservation"); });
});

describe("소스 계약 — 뒤로가기를 고정 링크(push)로 만들지 않는다", () => {
  const chk = readFileSync("app/checkout/page.tsx", "utf8"), center = readFileSync("app/center/[id]/page.tsx", "utf8");
  it("결제 화면 헤더 ‹ 는 BackButton(router.back 정책)이고 고정 href 앵커가 아니다", () => {
    expect(chk).not.toMatch(/<a className="side" href=\{centerBackHref\}>/); expect((chk.match(/<BackButton fallbackHref=\{centerBackHref\}/g) ?? []).length).toBe(3);
  });
  it("구매 시트의 결제 이동은 전체 문서 로드(window.location.href)가 아니라 router.push", () => {
    expect(center).toMatch(/function handlePurchase[\s\S]*?router\.push\(url\)/); expect(center.match(/function handlePurchase[\s\S]*?\n  }\n/)![0].replace(/\/\/[^\n]*/g, "")).not.toContain("window.location.href");
  });
});
