/*
  .daylist-empty 상단 여백 변형 계약(2026-10-06): 인라인 paddingTop 20/30/40/60/80을 이름 있는 변형으로 옮겼어도 어떤 맥락에서든 같은 computed 값을 갖는지 Chromium으로 확인하고,
  인라인 style이 다시 늘어나지 않게 정적으로 막는다. Chromium을 띄울 수 없으면 레이아웃 테스트는 건너뛴다.
*/
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const css = ["globals.css", "workspace.css"].map((f) => readFileSync(path.join(root, "app", f), "utf8")).join("\n");
const VARIANTS: [string, number][] = [["page", 80], ["lg", 60], ["md", 40], ["sm", 30], ["xs", 20]];
const contexts: Record<string, (inner: string) => string> = {
  "일반 app-shell": (i) => `<div class="app-shell"><div class="back-header"><div class="title">t</div></div>${i}</div>`,
  "manager 본문": (i) => `<div class="manager-v3"><main class="manager-v3-content"><div class="app-shell">${i}</div></main></div>`,
  "admin 본문": (i) => `<div class="admin-v3"><main class="admin-v3-content"><div class="app-shell">${i}</div></main></div>`,
  "manager 시트 안": (i) => `<div class="manager-v3"><main class="manager-v3-content"><div class="app-shell"><div class="sheet">${i}</div></div></main></div>`,
};
let browser: import("@playwright/test").Browser | null = null; let pg: import("@playwright/test").Page;
beforeAll(async () => { try { const { chromium } = await import("@playwright/test"); browser = await chromium.launch(); pg = await browser.newPage({ viewport: { width: 390, height: 844 } }); } catch { browser = null; } }, 60_000);
afterAll(async () => { await browser?.close(); });
const doc = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;

describe(".daylist-empty 변형", () => {
  it("모든 맥락(일반/manager/admin/시트)에서 변형 클래스의 padding-top이 기존 인라인 값(80/60/40/30/20)과 같고, 하위 padding/정렬은 맥락 규칙 그대로", async (ctx) => {
    if (!browser) return ctx.skip();
    for (const [ctxName, wrap] of Object.entries(contexts)) {
      for (const [v, px] of VARIANTS) {
        await pg.setContent(doc(wrap(`<div class="daylist-empty daylist-empty--${v}" id="a">비었어요</div><div class="daylist-empty" id="old" style="padding-top:${px}px">비었어요</div>`)));
        const r = await pg.evaluate(() => { const g = (id: string) => { const c = getComputedStyle(document.getElementById(id)!); return { pt: c.paddingTop, pb: c.paddingBottom, pl: c.paddingLeft, mh: c.minHeight, d: c.display, pi: c.placeItems }; }; return { a: g("a"), old: g("old") }; });
        expect(r.a, `${ctxName} / ${v}`).toEqual(r.old);
        expect(r.a.pt).toBe(`${px}px`);
      }
    }
  }, 60_000);
});

describe("정적 계약", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  it("daylist-empty에 인라인 paddingTop을 다시 쓰지 않는다(변형 클래스 사용)", () => {
    const bad = walk(path.join(root, "app")).filter((f) => f.endsWith(".tsx")).flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l] as const).filter(([, , l]) => /daylist-empty/.test(l) && /paddingTop/.test(l)).map(([f2, i]) => `${path.relative(root, f2)}:${i}`));
    expect(bad).toEqual([]);
  });
  it("변형 토큰은 5종이며 safe-area 토큰(--page-state-top)과 섞이지 않는다", () => {
    for (const [v, px] of VARIANTS) expect(css).toContain(`.daylist-empty--${v} { --empty-pad: ${px}px; }`);
    const g = readFileSync(path.join(root, "app/globals.css"), "utf8");
    const block = g.slice(g.indexOf(".daylist-empty--page { --empty-pad"));
    expect(block).not.toContain("--page-state-top");
    expect(block).not.toMatch(/!important/);
  });
});
