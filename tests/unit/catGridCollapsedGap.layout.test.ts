/*
  홈 종목 그리드(tablet/desktop) 접힌 상태 하단 불필요 여백 회귀 테스트 — 실제 globals.css/workspace.css를 headless Chromium에서 측정한다(네트워크 없음).
  Chromium을 띄울 수 없는 환경에서는 건너뛴다.
*/
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const css = ["globals.css", "workspace.css"].map((f) => readFileSync(path.join(root, "app", f), "utf8")).join("\n");

const items = (n: number) => Array.from({ length: n }, (_, i) => `<a class="cat-item" href="#"><span class="cat-icon">${i}</span><span class="cat-label">종목${i}</span></a>`).join("");
const page = (n: number, expanded: boolean) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body>
<div class="app-shell member-home"><div class="home-category-head" id="head"><h2>종목 둘러보기</h2><button>더보기</button></div>
<div class="cat-grid ${expanded ? "is-expanded" : ""}" id="grid">${items(n)}</div><div id="after">다음</div></div></body></html>`;

let browser: import("@playwright/test").Browser | null = null;
let pg: import("@playwright/test").Page;
beforeAll(async () => { try { const { chromium } = await import("@playwright/test"); browser = await chromium.launch(); pg = await browser.newPage(); } catch { browser = null; } }, 60_000);
afterAll(async () => { await browser?.close(); });

const measure = () => pg.evaluate(() => {
  const r = (e: Element) => e.getBoundingClientRect();
  const grid = document.getElementById("grid")!, head = document.getElementById("head")!, after = document.getElementById("after")!;
  const its = [...grid.querySelectorAll(".cat-item")].map((e) => r(e));
  const cs = getComputedStyle(grid);
  // 보이는 행 = top이 서로 다른 아이템들 중 높이>0인 앞 2개 행
  const rows: { top: number; bottom: number }[] = [];
  for (const b of its) { if (b.height <= 0.5) continue; if (!rows.some((x) => Math.abs(x.top - b.top) < 1)) rows.push({ top: b.top, bottom: b.bottom }); }
  const visible = rows.sort((a, b) => a.top - b.top).slice(0, 2);
  return { headBottom: r(head).bottom, firstTop: visible[0].top, secondTop: visible[1]?.top ?? null, row1Bottom: visible[0].bottom, lastBottom: visible[visible.length - 1].bottom,
    gridTop: r(grid).top, gridBottom: r(grid).bottom, afterTop: r(after).top, rowCount: rows.length, padBottom: parseFloat(cs.paddingBottom), pad: cs.paddingTop, rowGap: cs.rowGap };
});

describe("홈 종목 그리드 — tablet/desktop 접힌 상태", () => {
  it("숨겨진 행이 있어도 보이는 2행 아래에 row-gap만큼의 추가 여백이 없고(grid 하단 = 2행 하단 + padding-bottom), 첫 행/행 간격은 펼친 상태와 동일", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const [vw, vh] of [[768, 900], [820, 1180], [1024, 768], [1280, 800], [1440, 900], [1024, 600], [900, 640]] as const) {
      for (const n of [13, 11, 17, 21]) {
        await pg.setViewportSize({ width: vw, height: vh });
        await pg.setContent(page(n, false)); const c = await measure();
        await pg.setContent(page(n, true)); const e = await measure();
        const tag = `${vw}x${vh} n=${n}`;
        expect(Math.abs(c.firstTop - e.firstTop), `${tag}: 첫 행 위치가 펼친 상태와 다름`).toBeLessThanOrEqual(1);
        expect(c.secondTop === null || Math.abs((c.secondTop ?? 0) - (e.secondTop ?? 0)) <= 1, `${tag}: 2행 위치가 다름`).toBe(true);
        // 접힌 상태 하단: 보이는 마지막 행 + padding-bottom 외에 남는 공간 없음(±1)
        expect(c.gridBottom - c.lastBottom, `${tag}: 접힌 하단 여백 과다`).toBeLessThanOrEqual(c.padBottom + 1);
        expect(c.afterTop - c.lastBottom, `${tag}: 다음 요소까지 간격 과다`).toBeLessThanOrEqual(c.padBottom + 1);
      }
    }
  }, 120_000);

  it("보이는 행이 2행 이하인 적은 항목 수에서도 위치/하단 간격이 펼친 상태와 같다(첫·둘째 행 위치 동일, 하단 = 마지막 행 + padding-bottom)", async (ctx) => {
    if (!browser) return ctx.skip();
    await pg.setViewportSize({ width: 1440, height: 900 });
    for (const n of [1, 2, 4, 8]) {
      await pg.setContent(page(n, false)); const c = await measure();
      await pg.setContent(page(n, true)); const e = await measure();
      expect(Math.abs(c.firstTop - e.firstTop), `n=${n}`).toBeLessThanOrEqual(1);
      expect(c.secondTop === null || Math.abs((c.secondTop ?? 0) - (e.secondTop ?? 0)) <= 1, `n=${n} 2행`).toBe(true);
      expect(c.gridBottom - c.lastBottom, `n=${n}: 하단 여백`).toBeLessThanOrEqual(c.padBottom + 1);
    }
  });

  it("컨테이너가 앞 요소(헤더 버튼) 클릭을 가로채지 않는다(pointer-events) / 아이템은 클릭 가능 / mobile(<768)은 영향 없음", async (ctx) => {
    if (!browser) return ctx.skip();
    await pg.setViewportSize({ width: 1024, height: 900 });
    await pg.setContent(page(13, false));
    const pe = await pg.evaluate(() => ({ grid: getComputedStyle(document.getElementById("grid")!).pointerEvents, item: getComputedStyle(document.querySelector(".cat-item")!).pointerEvents }));
    expect(pe).toEqual({ grid: "none", item: "auto" });
    await pg.setViewportSize({ width: 390, height: 844 });
    await pg.setContent(page(8, false));
    const m = await pg.evaluate(() => ({ grid: getComputedStyle(document.getElementById("grid")!).pointerEvents, mt: getComputedStyle(document.querySelector(".cat-item")!).marginTop }));
    expect(m).toEqual({ grid: "auto", mt: "0px" });
  });
});

describe("정적 계약", () => {
  it("collapsed 규칙은 @media(min-width:768px)에만, 토큰(--cat-row-gap/--cat-pad-top) 사용, DOM 순서/기기별 숫자 하드코딩 없음", () => {
    const g = readFileSync(path.join(root, "app/globals.css"), "utf8");
    const block = g.slice(g.lastIndexOf("@media (min-width: 768px) {\n  .member-home .cat-grid:not(.is-expanded)"));
    expect(block).toContain("row-gap: 0;");
    expect(block).toContain("var(--cat-row-gap");
    expect(block).not.toMatch(/\b\d{2,3}px\b(?!\))/);   // 18px/8px는 var() fallback 안에서만
    expect(g).toContain("--cat-row-gap: 18px;");
  });
});
