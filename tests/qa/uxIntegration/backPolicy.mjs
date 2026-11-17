import { ctxFor, BASE, UX, pid, browser, settle, check, save } from "./lib.mjs";
const FREE = pid("[UX] 자유 선택 수강권");
const path = (p) => { const u = new URL(p.url()); return u.pathname + u.search; };
const bridge = (p) => p.evaluate(() => window.__mwhabitBack?.());
const { page: p } = await ctxFor();
// D1/D2 시트 열림 상태
await p.goto(`${BASE}/center/${UX}?buy=1`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
const open = () => p.evaluate(() => !!document.querySelector("[data-sheet-overlay]"));
// D2 확인창(alertdialog)이 떠 있으면 시트도 닫지 않고 이동도 없음 — DOM 계약 모사
await p.evaluate(() => { const d = document.createElement("div"); d.setAttribute("role", "alertdialog"); d.id = "fake-confirm"; document.body.appendChild(d); });
const urlBefore = path(p); const dec1 = await bridge(p); await settle(p, 800);
check("D2", "확인창(alertdialog) 열림 + back → 아무 동작 없음(시트·화면 유지) [DOM 계약 모사]", dec1 === "blocked-by-dialog" && (await open()) && path(p) === urlBefore ? "PASS" : "FAIL", `${dec1} open=${await open()}`);
await p.evaluate(() => document.getElementById("fake-confirm")?.remove());
const dec2 = await bridge(p); await settle(p, 800);
check("D1", "시트 열림 + back → 시트만 닫힘, 같은 화면(배경 이동 없음)", dec2 === "close-overlay" && !(await open()) && new URL(p.url()).pathname === `/center/${UX}` ? "PASS" : "FAIL", `${dec2} ${path(p)}`);
// D3 앱 안 이동 후 ‹ 와 bridge(스와이프/Android back)의 도착지가 같다
// 홈 → 센터(클릭 이동) → 결제(시트 구매) 에서 ‹ vs bridge
async function clickPath() {
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await settle(p, 2500);
  await p.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" }); await settle(p, 1500);
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await settle(p, 2000);
  await p.getByRole("link", { name: "판매 상품" }).first().click(); await settle(p, 2500);
  await p.locator("a[href*='/center/']").first().click(); await settle(p, 3000);
  if (await open()) { await bridge(p); await settle(p, 800); }   // ?buy=1 로 열린 시트는 먼저 닫는다(첫 back = 시트만 닫기)
}
await clickPath(); const here = path(p);
const back = p.locator(".back-header a.side, .back-header button.side, .app-back-btn").first();
await back.click(); await settle(p, 2500); const viaButton = path(p);
await clickPath(); const decB = await bridge(p); await settle(p, 2500); const viaBridge = path(p);
check("D3", "앱 안 이동 후 ‹ 버튼 도착지 == back 브리지(스와이프/Android) 도착지", viaButton === viaBridge && decB === "history-back" ? "PASS" : "FAIL", `from ${here.slice(0, 30)} button=${viaButton} bridge=${viaBridge} (${decB})`);
// D4 딥링크 첫 진입(결제 화면)
await p.goto(`${BASE}/checkout?center=${UX}&product=${FREE}&count=4`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
const decD = await p.evaluate(() => { const d = window.__mwhabitBack?.(); return d; }); await settle(p, 2500); const viaBridge2 = path(p);
await p.goto(`${BASE}/checkout?center=${UX}&product=${FREE}&count=4`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
await p.locator(".back-header a.side, .back-header button.side, .app-back-btn").first().click(); await settle(p, 2500); const viaButton2 = path(p);
check("D4", "딥링크 첫 진입(결제 화면): ‹ 와 브리지가 같은 안전한 fallback 으로 이동(앱 종료/빈 화면 아님)", viaButton2 === viaBridge2 && decD === "fallback" && viaButton2 !== "" && !viaButton2.startsWith("/checkout") ? "PASS" : "FAIL", `button=${viaButton2.slice(0, 40)} bridge=${viaBridge2.slice(0, 40)} (${decD})`);
// D5 root
await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await settle(p, 2500);
check("D5", "root(홈): back → 'none'(이동·종료 판정은 네이티브), ‹ 없음", (await bridge(p)) === "none" && (await p.locator(".back-header .side:has-text('‹')").count()) === 0 ? "PASS" : "FAIL");
// D6 선택 화면에서 입력창 포커스/텍스트 선택은 영향 없음(브라우저에서 가능한 범위)
await p.goto(`${BASE}/center/${UX}?buy=1`, { waitUntil: "domcontentloaded" }); await settle(p, 3000);
await p.locator("[data-sheet-overlay] input, .is-sheet input").first().fill("11월"); await settle(p, 500);
check("D6", "시트 검색 입력은 정상(입력이 back/제스처 정책에 막히지 않음)", (await p.locator("[data-sheet-overlay] input, .is-sheet input").first().inputValue()) === "11월" && (await open()) ? "PASS" : "FAIL");
check("D7", "iOS 왼쪽 가장자리 제스처 / 오른쪽 앞으로 차단 / Android 시스템 back / 변경사항 버리기 실제 확인창", "BLOCKED", "실기기(네이티브) 전용 — 브라우저는 브리지 판정까지만 검증");
save("D2"); await browser.close();
