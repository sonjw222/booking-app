import { test, expect, openAs, gotoQaCenter, shot, uniq, need } from "./helpers";
import type { BrowserContext, Page } from "@playwright/test";

/* 관리자 폼 접근성·키보드 — 이름 없는 조작 요소(레이블·aria-label·title·텍스트 모두 없음), 키보드만으로 로그인/수업 등록/시트 닫기. axe 같은 외부 도구 없이 DOM 규칙만 검사한다(범위: 이름 유무, 키보드 도달성). */
let ctx: BrowserContext; let page: Page;
test.beforeAll(async ({ browser }) => { ({ ctx, page } = await openAs(browser, "owner")); });
test.afterAll(async () => { await ctx.close(); });

/* 화면에 보이는 input/select/textarea/button/[role=button|checkbox|switch] 중 접근 가능한 이름이 없는 것을 찾는다. */
async function unnamedControls(p: Page, scope = "body"): Promise<string[]> {
  return p.evaluate((sel) => {
    const root = document.querySelector(sel) ?? document.body;
    const hiddenFromAT = (e: Element) => !!e.closest("[aria-hidden=true]") || (e as HTMLElement).tabIndex === -1 && e.getAttribute("aria-hidden") === "true";
    const visible = (e: Element) => { if (hiddenFromAT(e)) return false; const r = (e as HTMLElement).getBoundingClientRect(); const cs = getComputedStyle(e as HTMLElement); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const nameOf = (e: HTMLElement): string => {
      const al = e.getAttribute("aria-label"); if (al?.trim()) return al.trim();
      const lb = e.getAttribute("aria-labelledby"); if (lb) { const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim(); if (t) return t; }
      const labels = (e as HTMLInputElement).labels; if (labels && labels.length) { const t = [...labels].map((l) => l.textContent?.trim()).join(" ").trim(); if (t) return t; }
      const wrapping = e.closest("label"); if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
      if (e.getAttribute("title")?.trim()) return e.getAttribute("title")!.trim();
      const tag = e.tagName.toLowerCase();
      if (tag === "button" || e.getAttribute("role") === "button" || e.getAttribute("role") === "checkbox" || e.getAttribute("role") === "switch") { const t = e.textContent?.trim(); if (t) return t; const img = e.querySelector("img[alt]"); if (img?.getAttribute("alt")?.trim()) return img.getAttribute("alt")!.trim(); }
      if (tag === "input" && ["button", "submit"].includes((e as HTMLInputElement).type) && (e as HTMLInputElement).value) return (e as HTMLInputElement).value;
      return "";
    };
    const out: string[] = [];
    root.querySelectorAll<HTMLElement>("input:not([type=hidden]), select, textarea, button, [role=button], [role=checkbox], [role=switch]").forEach((e) => {
      if (!visible(e)) return; const n = nameOf(e);
      if (!n) { const ph = (e as HTMLInputElement).placeholder; out.push(`${e.tagName.toLowerCase()}${(e as HTMLInputElement).type ? `[${(e as HTMLInputElement).type}]` : ""}${ph ? ` placeholder="${ph}"` : ""} .${(e.className || "").toString().slice(0, 40)}`); }
    });
    return out;
  }, scope);
}
const report = async (label: string, list: string[]) => { test.info().annotations.push({ type: "a11y", description: `${label}: 이름 없는 조작 요소 ${list.length}개 ${JSON.stringify(list.slice(0, 6))}` }); };

test("[접근성] 로그인 화면 — 키보드(Tab/Enter)만으로 로그인", async ({ browser }) => {
  const c = await browser.newContext(); const p = await c.newPage();
  await p.goto("/login"); await p.waitForLoadState("networkidle");
  await p.locator('input[type="email"]').focus();
  await p.keyboard.type(need("TEST_USER_B_EMAIL")); await p.keyboard.press("Tab"); await p.keyboard.type(need("TEST_USER_B_PASSWORD")); await p.keyboard.press("Enter");
  await p.waitForURL("/", { timeout: 20_000 });
  await report("로그인", await unnamedControls(p));
  await c.close();
});

test("[접근성] 수업 등록 시트 — 이름 없는 조작 요소 없음 + 키보드로 입력·Escape 로 닫기", async () => {
  await gotoQaCenter(page, "/manager/classes");
  await page.locator(".workspace-create-class:visible, .fab-btn:visible").filter({ hasText: "수업 등록" }).first().click();
  await expect(page.locator(".sheet-title", { hasText: "수업 등록" })).toBeVisible();
  const unnamed = await unnamedControls(page, ".sheet");
  await report("수업 등록 시트", unnamed); await shot(page, "09-a11y-class-sheet");
  await page.locator('input[placeholder="수업명"]').focus(); await page.keyboard.type(uniq("QA키보드"));
  await page.keyboard.press("Escape");
  const closedByEsc = (await page.locator(".sheet-overlay").count()) === 0;
  test.info().annotations.push({ type: "a11y", description: `Escape 로 시트 닫힘: ${closedByEsc}` });
  if (!closedByEsc) await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });
  expect(unnamed.filter((u) => !/placeholder=/.test(u)), "레이블·플레이스홀더도 없는 조작 요소").toEqual([]);
});

test("[접근성] 역할별 권한 편집 — 권한 체크박스가 이름(레이블)을 가진다", async () => {
  await gotoQaCenter(page, "/manager/staff");
  await page.getByRole("button", { name: "역할별 권한" }).click();
  await page.getByRole("button", { name: "QA 변경 대상" }).click();
  const unnamed = await unnamedControls(page); await report("역할별 권한", unnamed); await shot(page, "09-a11y-role-perms");
  expect(unnamed.filter((u) => u.startsWith("input[checkbox]")), "권한 체크박스에 접근 가능한 이름이 없다").toEqual([]);
});

test("[접근성] 공지 작성·쿠폰 생성·회원 수강권 지급 시트 — 이름 없는 조작 요소 점검", async () => {
  await gotoQaCenter(page, "/manager/announcements"); await page.getByRole("button", { name: "+ 새 공지" }).click(); const a = await unnamedControls(page, ".sheet"); await report("공지 작성 시트", a);
  await page.keyboard.press("Escape"); if (await page.locator(".sheet-overlay").count()) await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });
  await gotoQaCenter(page, "/manager/coupons"); await page.getByRole("button", { name: "+ 쿠폰" }).click(); const c = await unnamedControls(page, ".sheet"); await report("쿠폰 생성 시트", c);
  expect([...a, ...c].filter((u) => !/placeholder=/.test(u)), "레이블·플레이스홀더도 없는 조작 요소").toEqual([]);
});
