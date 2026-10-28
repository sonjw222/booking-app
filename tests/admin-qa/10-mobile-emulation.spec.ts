import { test, expect, sessionFor, shot, QA_CENTER_ID } from "./helpers";

/* 모바일 폭(390x844, iPhone 유사 에뮬레이션) 관리자 화면 — 가로 넘침·페이지 오류 점검. ⚠ 에뮬레이션이다: 실제 iOS/Android 기기 검증이 아니다(해당 항목은 BLOCKED 로 기록). */
const PATHS = ["/manager", "/manager/classes", "/manager/members", "/manager/orders", "/manager/coupons", "/manager/announcements", "/manager/reviews", "/manager/staff", "/manager/alimtalk", "/manager/settings", "/manager/sales"];
test("[오너] 모바일 폭 에뮬레이션 — 관리자 주요 화면 가로 넘침 없음·페이지 오류 없음", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: await sessionFor(browser, "owner"), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage(); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const overflow: string[] = [];
  for (const p of PATHS) {
    await page.goto(p); await page.waitForLoadState("networkidle");
    const sel = page.getByLabel("센터 선택"); if (await sel.count() && (await sel.first().inputValue()) !== QA_CENTER_ID()) { await sel.first().selectOption(QA_CENTER_ID()); await page.waitForLoadState("networkidle"); }
    const w = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (w > 1) overflow.push(`${p}: +${w}px`);
    await shot(page, `10-mobile${p.replace(/\//g, "_")}`);
  }
  await ctx.close();
  test.info().annotations.push({ type: "matrix", description: "실기기(iOS/Android) 관리자 폼 확인은 이 환경에서 수행 불가 → BLOCKED(에뮬레이션만 통과)" });
  expect(overflow).toEqual([]); expect(errors).toEqual([]);
});
