/*
  구매 sheet 역할 분리(선택 화면 = 무엇을 살지 / 결제 화면 = 횟수·옵션·금액) — 운영·Supabase 연결 없는 정적 하니스.
  실제 app/globals.css 와 CenterProductRow 가 만드는 마크업을 같은 상품 데이터로 렌더하고 실제 Chromium 으로 캡처·측정한다.
  사용: node tests/qa/purchaseSheet/shots.mjs
*/
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json"); const { chromium } = require("playwright");
const OUT = "docs/qa/ux-purchase-sheet-20261109"; fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true });
const css = fs.readFileSync("app/globals.css", "utf8");
const period = `<div class="center-product-period"><dl class="service-period is-compact"><div><dt>서비스 제공기간 <span>(이용 시작일 ~ 종료일)</span></dt><dd>2026년 11월 9일 ~ 2026년 11월 29일</dd></div></dl></div>`;
const HINT = "횟수·옵션은 결제 화면에서 선택해요";
const P = [
  { name: "1회 이용권", detail: "15,000원", avail: "판매 가능 3개", period: true },
  { name: "11월 스케줄링 수강권 ⓘ", detail: "80,000원부터", sel: true, period: true },
  { name: "필라테스 기구 프라이빗 12회 + 체험 1회 패키지 (평일 오전 전용 · 사이즈 선택형 양말 포함) ⓘ", detail: "600,000원부터", sel: true, avail: "판매 가능 12개", period: true },
  { name: "10월 체험 수강권", detail: "30,000원", avail: "매진", soldout: true },
];
const row = (p, persona) => `<div class="center-product-row is-sheet${p.sel ? " is-selectable" : ""}"><button class="center-product-info" style="background:none;border:none;text-align:left;flex:1"><div class="center-product-name">${p.name}</div>${p.sel ? `<div class="center-product-hint">${HINT}</div>` : ""}<div class="center-product-detail">${p.detail}</div>${p.avail ? `<div class="center-product-avail${p.soldout ? " is-soldout" : ""}">${p.avail}</div>` : ""}</button>${persona === "reviewer" ? (!p.soldout ? `<div class="center-product-actions"><a class="app-button app-button-secondary" href="#">결제 화면 확인 (구매 불가)</a></div>` : "") : (!p.soldout ? `<div class="center-product-actions"><button class="app-button app-button-secondary center-product-cart">담기</button><button class="app-button app-button-primary center-product-buy">구매</button></div>` : "")}${p.period ? period : ""}</div>`;
const page = (rows) => `<!doctype html><html lang="ko" data-theme="burgundy"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0;background:var(--bg)"><div class="center-products" style="max-width:560px;margin:0 auto;background:var(--card-bg)">${rows}</div></body></html>`;
const browser = await chromium.launch(); const metrics = [];
for (const persona of ["member", "reviewer"]) for (const w of [360, 390, 430, 1024]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2 }); const pg = await ctx.newPage();
  await pg.setContent(page(P.map((p) => row(p, persona)).join(""))); await pg.waitForTimeout(100);
  const m = await pg.evaluate(() => {
    const btns = [...document.querySelectorAll(".center-product-actions .app-button")];
    const h = btns.map((b) => Math.round(b.getBoundingClientRect().height));
    const sel = document.querySelectorAll(".center-product-row select").length;
    return { overflowX: document.documentElement.scrollWidth > window.innerWidth, selects: sel, minBtnH: Math.min(...h), maxBtnH: Math.max(...h), btnWidths: [...new Set(btns.map((b) => Math.round(b.getBoundingClientRect().width)))] };
  });
  metrics.push({ persona, width: w, ...m });
  await pg.screenshot({ path: path.join(OUT, "screenshots", `${persona}-${w}.png`), fullPage: true }); await ctx.close();
}
await browser.close(); fs.writeFileSync(path.join(OUT, "layout-metrics.json"), JSON.stringify(metrics, null, 1));
for (const m of metrics) console.log(`${m.persona.padEnd(8)} ${String(m.width).padStart(4)}px overflowX=${m.overflowX} selects=${m.selects} btnH=${m.minBtnH}-${m.maxBtnH} widths=${m.btnWidths.join("/")}`);
