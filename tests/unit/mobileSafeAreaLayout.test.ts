/*
  모바일 safe-area 레이아웃 회귀 테스트(2026-10-05) — 실제 globals.css/workspace.css + 실제 EmptyState/Loading 컴포넌트(SSR 마크업)를
  headless Chromium에 올려 bounding box로 검증한다(새 visual snapshot 프레임워크 없음).
  · 일반 브라우저에서는 env(safe-area-inset-*)가 항상 0이라 노치 문제를 못 잡는다 → 테스트에서만 CSS 텍스트의 env(safe-area-inset-X, 0px)를
    var(--sim-X, 0px)로 치환해 top/bottom/left/right inset을 주입한다(Production CSS는 env() 그대로, 기기별 숫자 없음).
  · 하단 nav는 BottomNav 컴포넌트가 next/navigation 훅을 써서 SSR할 수 없어 같은 class 구조(.bottom-nav > .nav-item)를 직접 마크업했다.
  · viewport는 모델명이 아니라 폭×높이 조합(대표값)으로만 검증한다. Chromium을 띄울 수 없는 환경(CI 등)에서는 테스트를 건너뛴다.
  · CSS_UNDER_TEST_DIR 환경변수로 다른 디렉터리의 CSS(예: 수정 전 origin/main 사본)를 검증해 "수정 전에는 실패"를 확인할 수 있다.
*/
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import EmptyState from "../../app/components/EmptyState";
import ErrorState from "../../app/components/ErrorState";
import Loading from "../../app/components/Loading";

const cssDir = process.env.CSS_UNDER_TEST_DIR ?? path.resolve(__dirname, "../../app");
const rawCss = ["globals.css", "workspace.css"].map((f) => readFileSync(path.join(cssDir, f), "utf8")).join("\n");
// env(safe-area-inset-top) / env(safe-area-inset-top, 0px) → 시뮬레이션 변수
const simCss = rawCss.replace(/env\(\s*safe-area-inset-(top|bottom|left|right)\s*(?:,\s*[^)]*)?\)/g, "var(--sim-$1, 0px)");

const nav = `<nav class="bottom-nav" aria-label="회원 주요 메뉴">${["홈", "찾기", "예약", "마이"].map((t, i) => `<a class="nav-item${i === 2 ? " active" : ""}" href="#"><div class="nav-icon"></div>${t}</a>`).join("")}</nav>`;
const html = (body: string, inset: { top: number; bottom: number; left?: number; right?: number }, zoom = 1) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${simCss}</style>` +
  `<style>:root{--sim-top:${inset.top}px;--sim-bottom:${inset.bottom}px;--sim-left:${inset.left ?? 0}px;--sim-right:${inset.right ?? 0}px}${zoom !== 1 ? `html{zoom:${zoom}}` : ""}</style></head><body>${body}${nav}</body></html>`;

const reservationLoggedOut = () => renderToStaticMarkup(h("div", { className: "app-shell" },
  h(EmptyState, { icon: "user", title: "로그인이 필요해요", description: "로그인하면 수강권을 확인하고 바로 예약할 수 있어요.",
    action: h("div", null, h("a", { className: "primary-btn", href: "#", id: "cta" }, "로그인하고 계속하기"), h("a", { className: "ghost-btn", style: { marginTop: 8 }, href: "#", id: "cta2" }, "홈으로 돌아가기")) })));
// app/mypage/page.tsx의 비로그인 마크업과 동일(아래 정적 테스트가 소스 일치를 확인한다)
const mypageLoggedOut = () => `<div class="app-shell"><div class="holiday-notice page-state-top" id="first"><div class="holiday-chip"><span class="hc-dot"></span>로그인이 필요해요</div></div><div style="padding:20px"><a class="primary-btn" href="/login" id="cta">로그인하러 가기</a></div></div>`;
const loadingFirst = () => renderToStaticMarkup(h("div", { className: "app-shell" }, h(Loading, {})));
const withHeader = () => `<div class="app-shell"><div class="back-header"><button class="side">‹</button><div class="title" id="first">장바구니</div><div class="side"></div></div>${renderToStaticMarkup(h(EmptyState, { icon: "cart", title: "장바구니가 비어 있어요", description: "센터에서 수강권이나 상품을 둘러보세요." }))}</div>`;

const VIEWPORTS: [number, number][] = [[320, 568], [360, 740], [375, 667], [375, 812], [390, 844], [393, 852], [402, 874], [414, 896], [430, 932], [440, 956]];
const INSETS = [{ top: 0, bottom: 0 }, { top: 20, bottom: 0 }, { top: 47, bottom: 34 }, { top: 59, bottom: 34 }, { top: 62, bottom: 34 }];
const LANDSCAPE: [number, number, { top: number; bottom: number; left: number; right: number }][] = [[667, 375, { top: 0, bottom: 0, left: 0, right: 0 }], [812, 375, { top: 0, bottom: 21, left: 44, right: 44 }], [852, 393, { top: 0, bottom: 21, left: 59, right: 59 }]];

let browser: import("@playwright/test").Browser | null = null;
let page: import("@playwright/test").Page;
beforeAll(async () => {
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch();
    page = await browser.newPage();
  } catch { browser = null; }
}, 60_000);
afterAll(async () => { await browser?.close(); });

type Box = { top: number; bottom: number; left: number; right: number };
const box = (sel: string) => page.evaluate((s) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right } as Box; }, sel);
const common = async (vw: number, vh: number) => {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  expect(m.sw, "가로 overflow").toBeLessThanOrEqual(m.iw);
  const n = await page.evaluate(() => { const r = document.querySelector(".bottom-nav")!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
  expect(n.bottom, "nav가 viewport 아래로 잘림").toBeLessThanOrEqual(vh);
  expect(n.left).toBeGreaterThanOrEqual(0); expect(n.right).toBeLessThanOrEqual(vw);
  return n;
};
const gap = 16; // --page-top-gap (디자인 최소 여백)

describe("모바일 safe-area 레이아웃(headless Chromium, inset 시뮬레이션)", () => {
  it("예약 비로그인: 대표 viewport × inset 조합에서 아이콘/제목이 safe-area+여백 아래, 가로 overflow 없음, 끝까지 스크롤하면 nav와 겹치지 않음, 큰 화면에서 과하게 내려가지 않음", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const [vw, vh] of VIEWPORTS) for (const inset of INSETS) {
      await page.setViewportSize({ width: vw, height: vh });
      await page.setContent(html(reservationLoggedOut(), inset)); 
      const tag = `${vw}x${vh} top${inset.top}/bottom${inset.bottom}`;
      const icon = await box(".app-empty-icon");
      expect(icon.top, `${tag}: 아이콘이 safe-area+여백 위`).toBeGreaterThanOrEqual(inset.top + gap);
      const n = await common(vw, vh);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const last = await page.evaluate(() => { const r = document.querySelector("#cta2")!.getBoundingClientRect(); return r.bottom; });
      expect(last, `${tag}: 마지막 버튼이 nav에 가림`).toBeLessThanOrEqual(n.top);
      if (vh >= 800) expect(icon.top, `${tag}: 큰 화면에서 상단 콘텐츠가 과하게 내려감`).toBeLessThanOrEqual(vh * 0.2 + inset.top);
      const title = await page.evaluate(() => { const e = document.querySelector(".app-empty-state b") as HTMLElement; return { sh: e.scrollHeight, ch: e.clientHeight }; });
      expect(title.sh).toBeLessThanOrEqual(title.ch + 1);
    }
  }, 120_000);

  it("마이 비로그인: 첫 카드가 safe-area+여백 아래, 예약 비로그인과 같은 시작 위치(공통 page-top rhythm), 로그인 버튼이 nav와 겹치지 않음", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const [vw, vh] of VIEWPORTS) for (const inset of INSETS) {
      await page.setViewportSize({ width: vw, height: vh });
      await page.setContent(html(mypageLoggedOut(), inset));
      const tag = `${vw}x${vh} top${inset.top}/bottom${inset.bottom}`;
      const card = await box("#first");
      expect(card.top, `${tag}: 카드가 safe-area 아래`).toBeGreaterThanOrEqual(inset.top + gap);
      const startMy = card.top;
      await page.setContent(html(reservationLoggedOut(), inset));
      const startResv = (await box(".app-empty-state")).top + (await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".app-empty-state")!).paddingTop)));
      expect(Math.abs(startMy - startResv), `${tag}: 두 비로그인 화면의 시작 위치 불일치`).toBeLessThanOrEqual(8);   // holiday-notice 6px 기본 margin 차이 허용 범위 밖이면 규칙이 갈라진 것
      await page.setContent(html(mypageLoggedOut(), inset));
      const n = await common(vw, vh);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      expect(await page.evaluate(() => document.querySelector("#cta")!.getBoundingClientRect().bottom), `${tag}: 버튼이 nav에 가림`).toBeLessThanOrEqual(n.top);
      const chip = await page.evaluate(() => { const e = document.querySelector(".holiday-chip") as HTMLElement; return { sh: e.scrollHeight, ch: e.clientHeight }; });
      expect(chip.sh).toBeLessThanOrEqual(chip.ch + 1);
    }
  }, 120_000);

  it("로딩 스켈레톤(첫 자식)도 같은 시작점 — 로딩에서 상태 화면으로 바뀔 때 위치가 튀지 않고 safe-area 아래", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const [vw, vh] of [[375, 812], [430, 932], [320, 568]] as const) for (const inset of INSETS) {
      await page.setViewportSize({ width: vw, height: vh });
      await page.setContent(html(loadingFirst(), inset));
      const t = await box(".loading-skeleton-title");
      expect(t.top, `${vw}x${vh} top${inset.top}`).toBeGreaterThanOrEqual(inset.top + gap);
      await common(vw, vh);
    }
  }, 60_000);

  it("헤더가 있는 일반 화면은 이중 padding이 없다: back-header가 safe-area를 한 번만 반영하고, 헤더 뒤 EmptyState는 기존 padding 유지", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const [vw, vh] of [[375, 812], [430, 932], [320, 568]] as const) for (const inset of INSETS) {
      await page.setViewportSize({ width: vw, height: vh });
      await page.setContent(html(withHeader(), inset));
      const tag = `${vw}x${vh} top${inset.top}`;
      const title = await box("#first");
      expect(title.top, tag).toBeGreaterThanOrEqual(inset.top);
      expect(title.top, `${tag}: 헤더 safe-area 이중 적용`).toBeLessThanOrEqual(inset.top + 16 + 8);
      const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".app-empty-state")!).paddingTop));
      expect(pad, `${tag}: 헤더 뒤 상태 화면 padding이 바뀜`).toBeLessThanOrEqual(40);
      await common(vw, vh);
    }
  }, 60_000);

  it("가로(landscape) 대표 3종: safe-area left/right/bottom inset에서도 overflow·nav 겹침 없이 스크롤로 모두 도달 가능", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const [vw, vh, inset] of LANDSCAPE) for (const body of [reservationLoggedOut(), mypageLoggedOut()]) {
      await page.setViewportSize({ width: vw, height: vh });
      await page.setContent(html(body, inset));
      const n = await common(vw, vh);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const last = await page.evaluate(() => document.querySelector("#cta2, #cta")!.getBoundingClientRect().bottom);
      expect(last).toBeLessThanOrEqual(n.top);
      const top = await page.evaluate(() => { const e = document.querySelector(".app-empty-icon, #first")!; return e.getBoundingClientRect().top + scrollY; });
      expect(top).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  it("큰 글자(브라우저 130% 확대): 제목/버튼이 잘리지 않고 가로 overflow 없음, 마지막 버튼이 스크롤로 nav 위에 도달", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const [vw, vh] of [[320, 568], [375, 812], [430, 932]] as const) for (const body of [reservationLoggedOut(), mypageLoggedOut()]) {
      await page.setViewportSize({ width: vw, height: vh });
      await page.setContent(html(body, { top: 59, bottom: 34 }, 1.3));
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      expect(m.sw).toBeLessThanOrEqual(m.iw + 1);
      const clipped = await page.evaluate(() => [...document.querySelectorAll(".app-empty-state b, .app-empty-state p, .primary-btn, .ghost-btn, .holiday-chip")].filter((e) => (e as HTMLElement).scrollHeight > (e as HTMLElement).clientHeight + 1).length);
      expect(clipped, `${vw}x${vh}: 잘린 텍스트/버튼`).toBe(0);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const r = await page.evaluate(() => ({ b: document.querySelector("#cta2, #cta")!.getBoundingClientRect().bottom, n: document.querySelector(".bottom-nav")!.getBoundingClientRect().top }));
      expect(r.b).toBeLessThanOrEqual(r.n);
    }
  }, 60_000);

  it("기본 .app-shell 하단 여백: 긴 일반 화면을 끝까지 스크롤하면 마지막 콘텐츠가 floating nav에 가리지 않는다(bottom inset 0/20/34/48 — 48은 Android 제스처 바급)", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const [vw, vh] of VIEWPORTS) for (const bottom of [0, 20, 34, 48]) {
      await page.setViewportSize({ width: vw, height: vh });
      await page.setContent(html(`<div class="app-shell"><div class="back-header"><div class="title">목록</div></div><div style="height:1800px"></div><div id="last" style="height:40px">끝</div></div>`, { top: 47, bottom }));
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const r = await page.evaluate(() => ({ b: document.querySelector("#last")!.getBoundingClientRect().bottom, n: document.querySelector(".bottom-nav")!.getBoundingClientRect().top }));
      expect(r.b, `${vw}x${vh} bottom${bottom}: 마지막 콘텐츠가 nav에 가림`).toBeLessThanOrEqual(r.n);
    }
  }, 60_000);

  it("error/not-found 전체 화면(.system-state-v2): 긴 콘텐츠에서도 상단이 safe-area 아래, 가로 overflow 없음", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const [vw, vh] of [[320, 568], [390, 844]] as const) {
      await page.setViewportSize({ width: vw, height: vh });
      await page.setContent(html(`<main class="system-state-v2"><h1 id="first">${"문제가 발생했어요 ".repeat(12)}</h1><p>${"설명 ".repeat(300)}</p><a class="app-button" href="#">홈으로</a></main>`, { top: 59, bottom: 34 }));
      expect((await box("#first")).top).toBeGreaterThanOrEqual(59 + 32);
      await common(vw, vh);
    }
  });

  describe("관리자/운영자 중첩 shell — 바깥 chrome이 safe-area를 처리하므로 page-state 시작점을 다시 적용하지 않는다", () => {
    const managerShell = (inner: string) => `<div class="manager-v3"><header class="manager-chrome"><div class="manager-chrome-main"><div class="app-chrome-title"><h1 id="chrome">대시보드</h1></div></div></header><main class="manager-v3-content"><div class="app-shell" id="shell">${inner}</div></main></div>`;
    const adminShell = (inner: string) => `<div class="admin-v3"><header class="admin-chrome"><div class="app-chrome-title"><h1 id="chrome">운영자</h1></div></header><main class="admin-v3-content"><div class="app-shell" id="shell">${inner}</div></main></div>`;
    const empty = renderToStaticMarkup(h(EmptyState, { icon: "building", title: "관리할 센터가 없어요", description: "센터를 등록해 주세요." }));
    const err = renderToStaticMarkup(h(ErrorState, { title: "관리 화면을 불러오지 못했어요", description: "x", action: h("a", { className: "primary-btn", href: "#" }, "다시 시도") }));
    const loading = renderToStaticMarkup(h(Loading, {}));
    const notice = `<div class="holiday-notice page-state-top"><div class="holiday-chip">안내</div></div>`;
    const cases: [string, (i: string) => string, string, string][] = [
      ["manager Loading", managerShell, loading, ".loading-skeleton-title"], ["manager EmptyState", managerShell, empty, ".app-empty-icon"], ["manager ErrorState", managerShell, err, ".app-empty-icon"],
      ["admin Loading", adminShell, loading, ".loading-skeleton-title"], ["admin EmptyState", adminShell, empty, ".app-empty-icon"], ["admin ErrorState", adminShell, err, ".app-empty-icon"],
    ];
    it("실제 중첩 DOM: chrome 아래 첫 콘텐츠 간격이 기존(≤ 40px)이고 top inset 0/20/47/59/62에서 달라지지 않는다(이중 safe-area 없음)", async (ctx) => {
      if (!browser) return ctx.skip();
      for (const [name, wrap, inner, sel] of cases) for (const [vw, vh] of [[375, 812], [430, 932], [320, 568]] as const) {
        const gaps: number[] = [];
        for (const inset of INSETS) {
          await page.setViewportSize({ width: vw, height: vh });
          await page.setContent(html(wrap(inner), inset));
          await page.evaluate(() => scrollTo(0, 0));   // sticky chrome의 viewport 좌표와 scrollY를 섞지 않도록 맨 위에서 측정
          const chrome = await box(".manager-chrome, .admin-chrome");
          const first = await box(sel);
          gaps.push(first.top - chrome.bottom);
          expect(first.top - chrome.bottom, `${name} ${vw}x${vh} top${inset.top}: chrome과 첫 콘텐츠 사이가 과도`).toBeLessThan(70);
          await common(vw, vh);
        }
        expect(Math.max(...gaps) - Math.min(...gaps), `${name} ${vw}x${vh}: top inset에 따라 간격이 변함(safe-area 이중 적용)`).toBeLessThanOrEqual(1);
      }
    }, 120_000);
    it("중첩 shell의 padding/margin은 원래 값 그대로(Loading 30px, EmptyState 32px 중앙 정렬 min-height 유지, page-state-top 6px)이고 최상위 shell은 새 규칙이 적용된다", async (ctx) => {
      if (!browser) return ctx.skip();
      await page.setViewportSize({ width: 390, height: 844 });
      const read = (sel: string) => page.evaluate((s) => { const cs = getComputedStyle(document.querySelector(s)!); return { pt: parseFloat(cs.paddingTop), mt: parseFloat(cs.marginTop), mh: parseFloat(cs.minHeight), jc: cs.justifyContent }; }, sel);
      for (const wrap of [managerShell, adminShell]) {
        await page.setContent(html(wrap(loading), { top: 59, bottom: 34 })); expect((await read(".loading-wrap")).pt).toBe(30);
        await page.setContent(html(wrap(empty), { top: 59, bottom: 34 })); const e = await read(".app-empty-state"); expect([e.pt, e.mh, e.jc]).toEqual([32, 240, "center"]);
        await page.setContent(html(wrap(notice), { top: 59, bottom: 34 })); expect((await read(".page-state-top")).mt).toBe(6);
      }
      await page.setContent(html(`<div class="app-shell">${loading}</div>`, { top: 59, bottom: 34 })); expect((await read(".loading-wrap")).pt).toBeGreaterThanOrEqual(59 + 16);
      await page.setContent(html(`<div class="app-shell">${notice}</div>`, { top: 59, bottom: 34 })); expect((await read(".page-state-top")).mt).toBeGreaterThanOrEqual(59 + 16);
      // 최상위 사용자 화면이 manager/admin 이름의 조상 아래에 있지 않은 한 규칙이 그대로 적용(예약/마이 비로그인 회귀 테스트가 별도로 검증)
    });
  });

  it("ErrorState도 같은 첫 화면 규칙을 따른다(헤더 없는 에러 화면)", async (ctx) => {
    if (!browser) return ctx.skip();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent(html(renderToStaticMarkup(h("div", { className: "app-shell" }, h(ErrorState, { title: "관리 화면을 불러오지 못했어요", description: "x", action: h("a", { className: "primary-btn", href: "#" }, "다시 시도") }))), { top: 59, bottom: 34 }));
    expect((await box(".app-empty-icon")).top).toBeGreaterThanOrEqual(59 + gap);
  });
});

describe("정적 계약(Chromium 불필요)", () => {
  const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");
  it("Production CSS는 env(safe-area-inset-*) 기반 토큰만 쓰고, 기기별 숫자/미디어쿼리/!important가 이 규칙에 없다", () => {
    expect(css).toMatch(/--safe-top:\s*env\(safe-area-inset-top\)/);
    expect(css).toMatch(/--page-state-top:\s*calc\(var\(--safe-top, 0px\) \+ var\(--page-top-gap\) \+ clamp\(24px, 6dvh, 56px\)\)/);
    const block = css.slice(css.indexOf("헤더가 없는 전체 화면 상태"), css.indexOf(".page-state-top:first-child {"));
    expect(block).not.toMatch(/!important|iphone|@media|\b(47|59|62)px/i);
    expect(css).toMatch(/\.app-shell \{ padding-bottom: max\(104px, calc\(var\(--floating-nav-clearance\) \+ 16px\)\); \}/);
  });
  it("mypage 비로그인은 임의 margin-top(60) 대신 공통 page-state-top 클래스를 쓴다", () => {
    const src = readFileSync(path.resolve(__dirname, "../../app/mypage/page.tsx"), "utf8");
    expect(src).toContain('className="holiday-notice page-state-top"');
    expect(src).not.toMatch(/holiday-notice[^>]*marginTop/);
  });
  it("관리자/운영자 layout 구조 가정: chrome + .manager-v3-content/.admin-v3-content 본문, manager/admin에는 자체 loading/error 경계가 없어 .system-state-v2·route-loading은 layout 바깥(최상위)에서만 렌더된다", () => {
    const mgr = readFileSync(path.resolve(__dirname, "../../app/manager/layout.tsx"), "utf8");
    const adm = readFileSync(path.resolve(__dirname, "../../app/admin/layout.tsx"), "utf8");
    expect(mgr).toMatch(/<ManagerChrome \/>[\s\S]*<main className="manager-v3-content">/);
    expect(adm).toMatch(/<AdminChrome \/><main className="admin-v3-content">/);
    for (const f of ["manager/loading.tsx", "manager/error.tsx", "admin/loading.tsx", "admin/error.tsx"]) expect(existsSync(path.resolve(__dirname, "../../app", f)), f).toBe(false);
    expect(css).toMatch(/\.manager-chrome \{[^}]*padding: max\(18px,var\(--safe-top\)\)/);
  });
  it("viewport-fit=cover 유지(safe-area env 값이 채워지는 전제)", () => {
    expect(readFileSync(path.resolve(__dirname, "../../app/layout.tsx"), "utf8")).toMatch(/viewportFit:\s*"cover"/);
  });
  it("native/Edge Function/SQL 파일을 건드리지 않는다는 전제: capacitor.config.ts의 contentInset은 never 유지", () => {
    expect(existsSync(path.resolve(__dirname, "../../capacitor.config.ts"))).toBe(true);
    expect(readFileSync(path.resolve(__dirname, "../../capacitor.config.ts"), "utf8")).toMatch(/contentInset:\s*"never"/);
  });
});
