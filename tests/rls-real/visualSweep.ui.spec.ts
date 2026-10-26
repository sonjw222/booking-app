/* 시각 QA 스윕: 회원·관리자 주요 경로를 라이트/다크 × 320/390/767/768/1024px 로 열어 (1) 페이지 가로 넘침 (2) 콘솔 error (3) 관리자 제목이 일반 fallback("관리자")이 아닌지 (4) 767→768 하단 메뉴/사이드바 전환을 확인한다.
   격리 DB(일부 운영 전용 객체 없음) + 실제 JWT. 데이터가 비어 있는 화면은 빈 상태 그대로 검사한다(저장·발송·결제 없음). */
import { expect, test, type Page } from "@playwright/test";
import { ID, U } from "./support";
import { loginAs } from "./uiLogin";
import { seedVisualQa, cleanupVisualQa } from "./visualQaSeed";

const THEMES = [["light", "burgundy"], ["dark", "charcoal"]] as const;
const SIZES: [number, number][] = [[320, 740], [390, 844], [767, 900], [768, 900], [1024, 900]];
const MEMBER = ["/", "/search", "/mypage", "/products", "/mypage/coupons", "/my-reservations", `/reservation?center=${ID.centerPub}`, `/center/${ID.centerPub}`];
const MANAGER = ["/manager", "/manager/settings", "/manager/classes", "/manager/members", "/manager/sales", "/manager/class-revenue", "/manager/orders", "/manager/reviews",
  "/manager/membership-rules", "/manager/goods", "/manager/coupons", "/manager/announcements", "/manager/leads", "/manager/rooms", "/manager/inquiries", "/manager/progress",
  "/manager/center-info", "/manager/alimtalk", "/manager/staff", "/manager/subscription", "/manager/settlement", "/manager/holidays"];

test.beforeAll(() => seedVisualQa());
test.afterAll(() => cleanupVisualQa());

// 알려진 격리 환경 오류(KNOWN_ENV_RULES)는 정확한 종류·상태·경로·원인을 지정한 것만 허용한다. 그 밖의 모든 raw 이벤트는 예상 밖(unexpected)으로 실패한다.
import { attachCollector, classify, formatReport, waitForSettled, hasErrorUi, type KnownRule } from "./errorCollector";
import { KNOWN_ENV_RULES, LAYOUT_ONLY_PATHS } from "./knownEnvErrors";
import fs from "node:fs";

const DISCOVER = process.env.VISUAL_SWEEP_DISCOVER; // 발견 모드: 규칙 없이 raw 만 JSON 으로 덤프(실패시키지 않음)

async function sweep(page: Page, paths: string[], who: string, rules: KnownRule[] = KNOWN_ENV_RULES) {
  const problems: string[] = []; const layoutOnly = new Set<string>();
  const col = attachCollector(page);
  await loginAs(page, who, "x@test.invalid");
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    for (const p of paths) {
      col.setWhere(`${p} @${w}`);
      await page.goto(p, { waitUntil: "domcontentloaded" });
      // 고정 대기 대신 로딩 표시가 사라질 때까지(데이터 로드 완료 또는 정상 빈 상태) 기다린다. 끝나지 않으면 문제로 기록한다.
      if (!(await waitForSettled(page))) problems.push(`${p} @${w}: 로딩이 끝나지 않음(또는 네트워크가 잠잠해지지 않음)`);
      const errUi = await hasErrorUi(page);
      if (errUi && p in LAYOUT_ONLY_PATHS) layoutOnly.add(p); // 격리 환경 한계로 오류 화면이 정상 — 데이터 흐름은 미검증(레이아웃만)
      else if (errUi) problems.push(`${p} @${w}: 정상 시나리오인데 오류 화면 문구("${errUi}")가 보임`);
      const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - window.innerWidth, vw: window.innerWidth, h1: document.querySelector("h1")?.textContent?.trim() ?? "" }));
      if (m.vw !== w) problems.push(`${p} @${w}: innerWidth ${m.vw}`);
      if (m.over > 1) problems.push(`${p} @${w}: 가로 넘침 ${m.over}px`);
      if (p.startsWith("/manager") && m.h1 === "관리자") problems.push(`${p} @${w}: 제목이 일반 fallback "관리자"`);
    }
  }
  await col.flush();
  const c = classify(col.events, rules);
  return { problems, c, events: col.events, layoutOnly: [...layoutOnly] };
}

function reportErrors(c: ReturnType<typeof classify>, label: string, events: unknown[], layoutOnly: string[] = []) {
  const text = formatReport(c, label) + (layoutOnly.length ? `\n  레이아웃만 검증(정상 데이터 흐름 미검증 — 격리 환경 한계로 오류 화면): ${layoutOnly.map((p) => `${p} [${LAYOUT_ONLY_PATHS[p]}]`).join(", ")}` : "");
  console.log(text);
  if (DISCOVER) fs.writeFileSync(`${DISCOVER}-${label.replace(/[^\p{L}\p{N}]+/gu, "_")}.json`, JSON.stringify(events));
  return text;
}

for (const [tn, theme] of THEMES) {
  test(`[${tn}] 회원 경로 스윕 (${MEMBER.length}개 × ${SIZES.length}폭)`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.addInitScript((t) => localStorage.setItem("app_theme", t), theme);
    const r = await sweep(page, MEMBER, U.A, DISCOVER ? [] : KNOWN_ENV_RULES);
    const rep = reportErrors(r.c, `${tn} 회원`, r.events);
    expect(r.problems, r.problems.join("\n")).toEqual([]);
    if (!DISCOVER) expect(r.c.unexpected, rep).toEqual([]);
  });
  test(`[${tn}] 관리자 경로 스윕 (${MANAGER.length}개 × ${SIZES.length}폭)`, async ({ page }) => {
    test.setTimeout(900_000);
    await page.addInitScript((t) => localStorage.setItem("app_theme", t), theme);
    const r = await sweep(page, MANAGER, U.M, DISCOVER ? [] : KNOWN_ENV_RULES);
    const rep = reportErrors(r.c, `${tn} 관리자`, r.events, r.layoutOnly);
    expect(r.problems, r.problems.join("\n")).toEqual([]);
    if (!DISCOVER) expect(r.c.unexpected, rep).toEqual([]);
  });
}

/* 의도한 오류 화면(정상 데이터 흐름 검증이 아님): 공개 상품 목록(/products) 조회를 일부러 500 으로 만들어 오류 화면의 레이아웃을 본다.
   허용되는 오류는 주입한 그 요청(rpc 500, 코드 XX000)뿐이다 — 그 밖의 오류는 격리 환경 알려진 규칙에도 안 맞으면 실패한다. */
const INJECTED: KnownRule = { id: "injected-storefront-500", cause: "시험이 의도적으로 주입한 공개 상품 조회 실패", kind: ["http", "console"], status: 500, code: "XX000", path: /^\/rest\/v1\/rpc\/fetch_public_storefront_products$/ };
// 주입한 실패의 결과로 앱이 스스로 남기는 콘솔 오류(toUserMessage) — 주입 표지("injected")가 든 정확한 문구만 허용한다.
const INJECTED_LOG: KnownRule = { id: "injected-storefront-app-log", cause: "주입한 실패에 대해 앱이 남기는 [toUserMessage] 콘솔 오류", kind: ["console"], path: /^\/_next\/static\/chunks\/[^/]+\.js$/, text: /^\[toUserMessage\] Error: 상품을 불러오지 못했어요: injected\n/ };
async function injectStorefrontFailure(page: Page, extra?: string) {
  await page.route("**/rest/v1/rpc/fetch_public_storefront_products*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "XX000", message: "injected" }) }));
  if (extra) await page.route(extra, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "XX000", message: "extra" }) }));
}
for (const [tn, theme] of THEMES) {
  test(`[${tn}] 의도한 오류 화면(공개 상품 500): 오류 화면 레이아웃 통과 + 주입한 오류만 허용`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript((t) => localStorage.setItem("app_theme", t), theme);
    await injectStorefrontFailure(page);
    const col = attachCollector(page); await loginAs(page, U.A, "a@test.invalid");
    for (const [w, h] of [[320, 740], [390, 844], [768, 900], [1024, 900]] as const) {
      await page.setViewportSize({ width: w, height: h }); col.setWhere(`/products @${w}`);
      await page.goto("/products", { waitUntil: "domcontentloaded" });
      expect(await waitForSettled(page), `${w}px: 오류 화면이 로딩 상태에서 안 벗어남`).toBe(true);
      await expect(page.locator(".daylist-empty", { hasText: "상품을 불러오지 못했어요" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${w}px 가로 넘침`).toBeLessThanOrEqual(1);
    }
    await col.flush();
    const c = classify(col.events, [...KNOWN_ENV_RULES, INJECTED, INJECTED_LOG]);
    const rep = reportErrors(c, `${tn} 의도한 오류 화면`, col.events);
    expect(c.knownByRule["injected-storefront-500"]?.count ?? 0, "주입한 오류가 관측되지 않음").toBeGreaterThan(0);
    expect(c.unexpected, rep).toEqual([]);
  });
}
test("의도한 오류 화면에서 주입한 것 말고 오류가 하나라도 더 나면 예상 밖으로 잡힌다", async ({ page }) => {
  await injectStorefrontFailure(page, "**/__extra_failure*");
  const col = attachCollector(page); await loginAs(page, U.A, "a@test.invalid");
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/products", { waitUntil: "domcontentloaded" }); await waitForSettled(page);
  await page.evaluate(() => fetch("/__extra_failure").catch(() => null)); // 주입한 것 말고 요청 하나가 더 실패
  await page.waitForTimeout(300); await col.flush();
  const c = classify(col.events, [...KNOWN_ENV_RULES, INJECTED, INJECTED_LOG]);
  expect(c.unexpected.some((e) => e.path === "/__extra_failure" && e.status === 500)).toBe(true);
});

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
