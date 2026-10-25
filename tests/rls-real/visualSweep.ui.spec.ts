/* 시각 QA 스윕: 회원·관리자 주요 경로를 라이트/다크 × 320/390/767/768/1024px 로 열어 (1) 페이지 가로 넘침 (2) 콘솔 error (3) 관리자 제목이 일반 fallback("관리자")이 아닌지 (4) 767→768 하단 메뉴/사이드바 전환을 확인한다.
   격리 DB(일부 운영 전용 객체 없음) + 실제 JWT. 데이터가 비어 있는 화면은 빈 상태 그대로 검사한다(저장·발송·결제 없음). */
import { expect, test, type Page } from "@playwright/test";
import { ID, U } from "./support";
import { loginAs } from "./uiLogin";
import { seedVisualQa, cleanupVisualQa } from "./visualQaSeed";

const THEMES = [["light", "burgundy"], ["dark", "charcoal"]] as const;
const SIZES: [number, number][] = [[320, 740], [390, 844], [767, 900], [768, 900], [1024, 900]];
const MEMBER = ["/", "/search", "/mypage", "/purchases", "/mypage/coupons", "/my-reservations", `/reservation?center=${ID.centerPub}`, `/center/${ID.centerPub}`];
const MANAGER = ["/manager", "/manager/settings", "/manager/classes", "/manager/members", "/manager/sales", "/manager/class-revenue", "/manager/orders", "/manager/reviews",
  "/manager/membership-rules", "/manager/goods", "/manager/coupons", "/manager/announcements", "/manager/leads", "/manager/rooms", "/manager/inquiries", "/manager/progress",
  "/manager/center-info", "/manager/alimtalk", "/manager/staff", "/manager/subscription", "/manager/settlement", "/manager/holidays"];

test.beforeAll(() => seedVisualQa());
test.afterAll(() => cleanupVisualQa());

// 격리 DB 에 없는 객체(운영 전용 테이블/RPC)나 로그인 세션 유지용 호출에서 나는 오류는 앱 결함이 아니므로 구분해 기록한다.
// 격리 프록시에는 Realtime(WebSocket)이 없어 알림 구독 연결 실패가 매 페이지 나온다(환경 한계, 앱 결함 아님).
const ENV_NOISE = [/WebSocket connection/i, /Failed to load resource/i, /\/rest\/v1\/|\/rpc\//i, /favicon/i, /Download the React DevTools/i];

async function sweep(page: Page, paths: string[], who: string) {
  const problems: string[] = []; const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !ENV_NOISE.some((re) => re.test(m.text()))) errors.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 160)));
  await loginAs(page, who, "x@test.invalid");
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    for (const p of paths) {
      await page.goto(p, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600);
      const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - window.innerWidth, vw: window.innerWidth, h1: document.querySelector("h1")?.textContent?.trim() ?? "" }));
      if (m.vw !== w) problems.push(`${p} @${w}: innerWidth ${m.vw}`);
      if (m.over > 1) problems.push(`${p} @${w}: 가로 넘침 ${m.over}px`);
      if (p.startsWith("/manager") && m.h1 === "관리자") problems.push(`${p} @${w}: 제목이 일반 fallback "관리자"`);
    }
  }
  return { problems, errors };
}

for (const [tn, theme] of THEMES) {
  test(`[${tn}] 회원 경로 스윕 (${MEMBER.length}개 × ${SIZES.length}폭)`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.addInitScript((t) => localStorage.setItem("app_theme", t), theme);
    const r = await sweep(page, MEMBER, U.A);
    expect(r.problems, r.problems.join("\n")).toEqual([]);
    expect([...new Set(r.errors)], r.errors.join("\n")).toEqual([]);
  });
  test(`[${tn}] 관리자 경로 스윕 (${MANAGER.length}개 × ${SIZES.length}폭)`, async ({ page }) => {
    test.setTimeout(900_000);
    await page.addInitScript((t) => localStorage.setItem("app_theme", t), theme);
    const r = await sweep(page, MANAGER, U.M);
    expect(r.problems, r.problems.join("\n")).toEqual([]);
    expect([...new Set(r.errors)], r.errors.join("\n")).toEqual([]);
  });
}

test("767→768px: 하단 메뉴와 사이드 메뉴가 서로 바뀌고, 넓혔다 다시 줄여도 원래 상태로 돌아온다 (회원·관리자)", async ({ page }) => {
  await loginAs(page, U.A, "a@test.invalid");
  const state = () => page.evaluate(() => {
    const vis = (sel: string) => { const e = document.querySelector(sel) as HTMLElement | null; if (!e) return false; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0; };
    return { bottom: vis(".bottom-nav"), side: vis(".member-desktop-nav") };
  });
  await page.setViewportSize({ width: 767, height: 900 }); await page.goto("/mypage"); await page.waitForTimeout(800);
  const a = await state(); expect(a).toEqual({ bottom: true, side: false });
  await page.setViewportSize({ width: 768, height: 900 }); await page.waitForTimeout(500);
  const b = await state(); expect(b).toEqual({ bottom: false, side: true });
  await page.setViewportSize({ width: 1280, height: 900 }); await page.waitForTimeout(300);
  await page.setViewportSize({ width: 767, height: 900 }); await page.waitForTimeout(500);
  expect(await state()).toEqual({ bottom: true, side: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
