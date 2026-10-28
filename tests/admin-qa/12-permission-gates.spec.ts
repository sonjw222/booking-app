import { test, expect, sessionFor, shot, QA_CENTER_ID, type Role } from "./helpers";
import type { Browser, Page } from "@playwright/test";

/* #248: /manager/alimtalk/* 와 /manager/sales 접근 게이트 — 오너·허용 직원(message.alimtalk.view + pass.sales.view)·제한 직원(조회 전용), 직접 URL 접근,
   데스크톱·모바일, 라이트·다크, 키보드. 권한 조회 중·실패는 허용이 아니다(요청 지연·차단으로 재현). 서버 정책·권한 키는 바꾸지 않았다. */
const ALIMTALK = ["/manager/alimtalk", "/manager/alimtalk/send", "/manager/alimtalk/rules", "/manager/alimtalk/templates", "/manager/alimtalk/settings"];
const MARK: Record<string, RegExp> = { "/manager/alimtalk": /알림톡 보내기|자동 발송 규칙/, "/manager/alimtalk/send": /발송 대상 검색/, "/manager/alimtalk/rules": /\+ 새로 만들기/, "/manager/alimtalk/templates": /템플릿/, "/manager/alimtalk/settings": /모하빗 알림톡 발송 서비스/, "/manager/sales": /수업매출 캘린더|결제수단별/ };
const DENIED = /화면을 볼 권한이 없어요/;
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844 } } as const;
const THEMES = { light: "burgundy", dark: "charcoal" } as const;

async function open(browser: Browser, role: Role, vp: keyof typeof VIEWPORTS, theme: keyof typeof THEMES) {
  const ctx = await browser.newContext({ storageState: await sessionFor(browser, role), viewport: VIEWPORTS[vp], isMobile: vp === "mobile" });
  await ctx.addInitScript((t) => { try { localStorage.setItem("app_theme", t); } catch { /* 무시 */ } }, THEMES[theme]);
  const page = await ctx.newPage(); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, errors };
}
async function selectQa(page: Page) { const sel = page.getByLabel("센터 선택"); if (await sel.count()) { await sel.first().selectOption(QA_CENTER_ID()); } }
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const matrix: Array<[Role, boolean]> = [["owner", true], ["allowed", true], ["limited", false]];
for (const [role, canOpen] of matrix) for (const vp of ["desktop", "mobile"] as const) for (const theme of ["light", "dark"] as const) {
  test(`[${role === "owner" ? "오너" : role === "allowed" ? "허용직원" : "제한직원"}] 직접 URL 접근 ${canOpen ? "허용" : "차단 안내"} — ${vp}·${theme}`, async ({ browser }) => {
    const { ctx, page, errors } = await open(browser, role, vp, theme);
    try {
      for (const path of [...ALIMTALK, "/manager/sales"]) {
        await page.goto(path); await page.waitForLoadState("networkidle");
        if (canOpen) {
          await expect(page.locator("body")).toContainText(MARK[path], { timeout: 15_000 });
          await expect(page.getByText(DENIED)).toHaveCount(0);
        } else {
          await expect(page.getByText(DENIED)).toBeVisible({ timeout: 15_000 });
          if (path === "/manager/sales") await expect(page.getByText(/결제수단별|순매출/)).toHaveCount(0);   // 0원 매출 화면이 아니라 안내
          if (path === "/manager/alimtalk/send") await expect(page.getByRole("checkbox")).toHaveCount(0);
        }
        expect(await overflow(page), `${path} 가로 넘침`).toBeLessThanOrEqual(1);
        if (path === "/manager/sales" || path === "/manager/alimtalk/send") await shot(page, `12-gate-${role}-${vp}-${theme}${path.replace(/\//g, "_")}`);
      }
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  });
}

test("[제한직원] 권한 조회 중에는 본문을 그리지 않는다(요청 지연) — 허용으로 보지 않음", async ({ browser }) => {
  const { ctx, page } = await open(browser, "limited", "desktop", "light");
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/rest\/v1\/(role_permissions|account_center_permissions)/, async (route) => { await gate; await route.continue(); });
  try {
    await page.goto("/manager/sales");
    await expect(page.getByText("권한을 확인하고 있어요…")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/결제수단별|순매출/)).toHaveCount(0);
    await shot(page, "12-gate-loading");
    release();
    await expect(page.getByText(DENIED)).toBeVisible({ timeout: 15_000 });
  } finally { release(); await ctx.close(); }
});
test("[허용직원] 권한 조회 실패(요청 차단)면 허용이 아니라 오류 안내 — 알림톡 발송·매출 모두", async ({ browser }) => {
  const { ctx, page } = await open(browser, "allowed", "desktop", "light");
  await page.route(/\/rest\/v1\/(role_permissions|account_center_permissions)/, (route) => route.abort());
  try {
    for (const path of ["/manager/alimtalk/send", "/manager/sales", "/manager/alimtalk/rules"]) {
      await page.goto(path); await page.waitForLoadState("networkidle");
      await expect(page.getByText("권한을 확인하지 못했어요")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(MARK[path])).toHaveCount(0);
    }
    await shot(page, "12-gate-lookup-error");
  } finally { await ctx.close(); }
});
test("[오너] 권한 조회 요청이 막혀도(오너는 전권) 정상 열림 — 오너 판정은 조회에 의존하지 않음", async ({ browser }) => {
  const { ctx, page } = await open(browser, "owner", "desktop", "light");
  await page.route(/\/rest\/v1\/(role_permissions|account_center_permissions)/, (route) => route.abort());
  try { await page.goto("/manager/sales"); await page.waitForLoadState("networkidle"); await expect(page.getByText(DENIED)).toHaveCount(0); await expect(page.getByText("권한을 확인하지 못했어요")).toHaveCount(0); } finally { await ctx.close(); }
});

test("[제한직원] 키보드 — 차단 안내 화면에서 Tab 으로 상단 '관리 홈' 링크에 닿고 Enter 로 이동, 홈의 알림톡 화면도 같은 게이트", async ({ browser }) => {
  const { ctx, page } = await open(browser, "limited", "mobile", "dark");
  try {
    await page.goto("/manager/alimtalk/templates"); await expect(page.getByText(DENIED)).toBeVisible({ timeout: 15_000 });
    let hit = false;
    for (let i = 0; i < 20 && !hit; i++) { await page.keyboard.press("Tab"); hit = await page.evaluate(() => (document.activeElement as HTMLAnchorElement | null)?.getAttribute("href") === "/manager" && /관리 홈/.test(document.activeElement?.textContent ?? "")); }
    expect(hit, "'관리 홈' 링크가 키보드로 도달 가능").toBe(true);
    await page.keyboard.press("Enter"); await page.waitForURL(/\/manager$/);
    await page.goto("/manager/alimtalk"); await expect(page.getByText(DENIED)).toBeVisible({ timeout: 15_000 });   // 홈(알림톡 목록)도 같은 게이트
    await shot(page, "12-gate-keyboard-mobile-dark");
  } finally { await ctx.close(); }
});

/* switch 접근 이름·상태 — 이름 없는 switch 0개 + 키보드(Space)로 상태 전환 */
const unnamedSwitches = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button.switch")].filter((e) => e.getBoundingClientRect().width > 0).filter((e) => !(e.getAttribute("role") === "switch" && e.hasAttribute("aria-checked") && (e.getAttribute("aria-label") || e.getAttribute("aria-labelledby")))).map((e) => e.outerHTML.slice(0, 80)));
test("[오너] switch 접근성 — 운영 설정·수강권·상품 시트의 모든 switch 가 이름·상태를 가지고 Space 로 전환된다", async ({ browser }) => {
  const { ctx, page } = await open(browser, "owner", "desktop", "light");
  try {
    await page.goto("/manager/settings"); await page.waitForLoadState("networkidle"); await selectQa(page);
    const sw = page.getByRole("switch", { name: "당일 예약 허용" }); await expect(sw).toBeVisible();
    const before = await sw.getAttribute("aria-checked"); await sw.focus(); await page.keyboard.press("Space");
    expect(await sw.getAttribute("aria-checked")).not.toBe(before);   // 상태가 aria-checked 로 노출되고 키보드로 바뀐다(저장하지 않음 — 새로고침하면 원복)
    expect(await unnamedSwitches(page)).toEqual([]);
    for (const [path, opener] of [["/manager/membership-rules", "+ 수강권"], ["/manager/goods", "+ 상품"]] as const) {
      await page.goto(path); await page.waitForLoadState("networkidle"); await selectQa(page);
      await page.getByRole("button", { name: opener, exact: true }).click();
      expect(await unnamedSwitches(page), `${path} 시트`).toEqual([]);
      expect(await page.getByRole("switch").count(), `${path} switch 존재`).toBeGreaterThan(0);
      await shot(page, `12-switch${path.replace(/\//g, "_")}`);
    }
  } finally { await ctx.close(); }
});
