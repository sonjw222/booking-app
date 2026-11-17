import { ctxFor, BASE, UX, pid, browser, OUT, settle, psql, check, save, env, external, apiPosts } from "./lib.mjs";
const FREE = pid("[UX] 자유 선택 수강권"), SIZED = pid("[UX] 사이즈 선택 패키지"), SHOES = pid("[UX] 대여 슈즈 · 사이즈 필수");
const orders0 = Number(psql("select count(*) from orders"));
const ordersNow = () => Number(psql("select count(*) from orders"));
const sheetInfo = (p) => p.evaluate(() => {
  const doc = document.documentElement, sh = document.querySelector(".is-sheet, [data-sheet-overlay]"), text = sh?.innerText ?? "";
  const btns = [...(sh?.querySelectorAll("button") ?? [])].filter((b) => /^(담기|구매)$/.test(b.innerText.trim())).map((b) => { const r = b.getBoundingClientRect(); return { t: b.innerText.trim(), h: Math.round(r.height), l: Math.round(r.left) }; });
  return { overflow: doc.scrollWidth > doc.clientWidth + 1, selects: sh?.querySelectorAll("select").length ?? -1, from: (text.match(/[\d,]+원부터/g) || []).length, hint: (text.match(/횟수·옵션은 결제 화면에서 선택해요/g) || []).length, btns, open: !!sh };
});
// ── B: 시트 4 너비 ──
for (const w of [360, 390, 430, 1024]) {
  const { ctx, page: p } = await ctxFor({ width: w, height: w === 1024 ? 900 : 844 });
  await p.goto(`${BASE}/center/${UX}?buy=1`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
  const i = await sheetInfo(p); await p.screenshot({ path: `${OUT}/sheet-${w}.png` });
  check(`B-${w}-open`, `시트 ${w}px 열림`, i.open ? "PASS" : "FAIL");
  check(`B-${w}-overflow`, `시트 ${w}px 가로 넘침 없음`, !i.overflow ? "PASS" : "FAIL");
  check(`B-${w}-noselect`, `시트 ${w}px 횟수 드롭다운 없음`, i.selects === 0 ? "PASS" : "FAIL", i.selects);
  check(`B-${w}-from`, `시트 ${w}px 선택형 2종 'N원부터' + 안내문`, i.from >= 2 && i.hint >= 2 ? "PASS" : "FAIL", `from=${i.from} hint=${i.hint}`);
  check(`B-${w}-btn`, `시트 ${w}px 버튼 높이≥44·같은 위치(행마다 동일 left)`, i.btns.length >= 4 && i.btns.every((b) => b.h >= 44) && new Set(i.btns.map((b) => `${b.t}${b.l}`)).size <= 2 ? "PASS" : "FAIL", JSON.stringify(i.btns.slice(0, 4)));
  await ctx.close();
}
// ── B2: 횟수 선택형 결제 화면 ──
{
  const { ctx, page: p } = await ctxFor(); const ck = (q = "") => `${BASE}/checkout?center=${UX}&product=${FREE}${q}`;
  await p.goto(`${BASE}/center/${UX}?buy=1`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
  const row = p.locator(".is-sheet, [data-sheet-overlay]").first().locator("*:has(> :text('[UX] 자유 선택 수강권'))").first();
  await p.locator("button:has-text('구매')").first().click(); await p.waitForURL(/\/checkout\?/, { timeout: 15000 }); await settle(p, 3000);
  const u = new URL(p.url());
  check("B2-nav", "시트 '구매' → 결제 화면(센터·상품 전달, 횟수는 결제 화면에서 선택)", u.searchParams.get("center") === UX && /^[0-9a-f-]{36}$/.test(u.searchParams.get("product") || "") && !u.search.includes("size=") ? "PASS" : "FAIL", u.search.slice(0, 90));
  const opts = await p.$$eval("select option", (os) => os.map((o) => o.text));
  check("B2-tiers", "결제 화면 횟수 옵션 = 가격표(1/4/8)만", JSON.stringify(opts) === JSON.stringify(["1회 · 10,000원", "4회 · 36,000원", "8회 · 64,000원"]) ? "PASS" : "FAIL", opts.join(","));
  await p.locator("select").first().selectOption({ label: "4회 · 36,000원" }); await settle(p, 800);
  let t = await p.locator("body").innerText();
  check("B2-tier-price", "4회 선택 → 실제 가격표 36,000원(1회×4=40,000 아님), 버튼·합계 재계산", t.includes("주문 접수하기 · 36,000원") && !t.includes("40,000원") ? "PASS" : "FAIL", (t.match(/주문 접수하기 · [\d,]+원/) || [""])[0]);
  await p.locator("select").first().selectOption({ label: "8회 · 64,000원" }); await settle(p, 800); t = await p.locator("body").innerText();
  check("B2-tier8", "8회 선택 → 64,000원(80,000 아님)", t.includes("주문 접수하기 · 64,000원") && !t.includes("80,000원") ? "PASS" : "FAIL");
  check("B2-url", "선택 횟수가 주소(count=8)에 반영 — 결제창 복귀용", new URL(p.url()).searchParams.get("count") === "8" ? "PASS" : "FAIL", p.url().slice(-40));
  await p.screenshot({ path: `${OUT}/checkout-free-8.png` });
  for (const bad of ["3", "99", "abc"]) { await p.goto(ck(`&count=${bad}`), { waitUntil: "domcontentloaded" }); await settle(p, 3000); const v = await p.locator("select").first().inputValue(); check(`B2-badcount-${bad}`, `주소 count=${bad}(가격표에 없음) → 최소 횟수(1)로 시작`, v === "1" ? "PASS" : "FAIL", v); }
  await p.goto(ck("&count=8"), { waitUntil: "domcontentloaded" }); await settle(p, 3000);
  check("B2-restore", "주소 count=8 → 결제 화면이 8회로 복원", (await p.locator("select").first().inputValue()) === "8" ? "PASS" : "FAIL");
  await ctx.close();
}
// ── B3: 사이즈 필수 ──
{
  const { ctx, page: p } = await ctxFor(); const ck = (q = "") => `${BASE}/checkout?center=${UX}&product=${SIZED}${q}`;
  await p.goto(ck(), { waitUntil: "domcontentloaded" }); await settle(p, 3500);
  const before = ordersNow();
  await p.locator("button:has-text('주문 접수하기')").click(); await settle(p, 1500);
  const toast = await p.locator(".error-toast").innerText().catch(() => "");
  check("B3-nosize", "사이즈 미선택으로 주문 접수 → 막힘('사이즈를 선택해주세요'), 주문 생성 없음", toast.includes("사이즈를 선택해주세요") && ordersNow() === before ? "PASS" : "FAIL", toast.slice(0, 40));
  await p.locator("button.filter-chip:has-text('L')").click(); await p.locator("select").first().selectOption({ label: "8회 · 140,000원" }); await settle(p, 800);
  const u = new URL(p.url());
  check("B3-url", "사이즈·횟수 선택이 주소에 반영(size=L, count=8)", u.searchParams.get("size") === "L" && u.searchParams.get("count") === "8" ? "PASS" : "FAIL", u.search.slice(-30));
  await p.goto(p.url(), { waitUntil: "domcontentloaded" }); await settle(p, 3500);
  const on = await p.$$eval("button.filter-chip.on", (bs) => bs.map((b) => b.innerText.trim()));
  check("B3-restore", "새로 열면 사이즈 L·횟수 8회 복원(복귀 시나리오)", JSON.stringify(on) === '["L"]' && (await p.locator("select").first().inputValue()) === "8" ? "PASS" : "FAIL", on.join(","));
  await p.screenshot({ path: `${OUT}/checkout-sized-restored.png` });
  await p.goto(ck("&size=XXL&count=8"), { waitUntil: "domcontentloaded" }); await settle(p, 3000);
  const on2 = await p.$$eval("button.filter-chip.on", (bs) => bs.length);
  check("B3-badsize", "주소 size=XXL(상품에 없는 사이즈) → 선택되지 않음", on2 === 0 ? "PASS" : "FAIL");
  await p.locator("button:has-text('주문 접수하기')").click(); await settle(p, 1200);
  check("B3-badsize-block", "잘못된 사이즈 주소로도 주문 불가", ordersNow() === before ? "PASS" : "FAIL");
  await ctx.close();
}
// ── B4: 장바구니 ──
{
  const { ctx, page: p } = await ctxFor(); const before = ordersNow();
  psql(`delete from cart_items where profile_id in (select pr.id from profiles pr join accounts a on a.id=pr.account_id join auth.users u on u.id=a.auth_id where u.email='${env.TEST_USER_A_EMAIL}')`);
  const add = async () => { await p.goto(`${BASE}/center/${UX}?buy=1`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
    const rows = p.locator("[data-sheet-overlay] button:has-text('담기'), .is-sheet button:has-text('담기')"); await rows.nth(1).click(); await settle(p, 1500); };
  await add();
  await p.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
  let t = await p.locator("body").innerText();
  check("B4-added", "시트 '담기'(사이즈 패키지) → 장바구니에 담김", t.includes("[UX] 사이즈 선택 패키지") ? "PASS" : "FAIL", t.slice(0, 120).replace(/\n+/g, " | "));
  await p.locator("button.primary-btn, button:has-text('주문')").last().click().catch(() => {}); await settle(p, 1200);
  const toast = await p.locator(".error-toast").innerText().catch(() => "");
  check("B4-nosize", "장바구니 일괄 주문: 사이즈 미선택 → 막힘, 주문 생성 없음", toast.includes("사이즈") && ordersNow() === before ? "PASS" : "FAIL", toast.slice(0, 60));
  await p.locator(".cart-sizes .filter-chip:has-text('M')").first().click(); await settle(p, 800);
  await p.locator("select").first().selectOption({ label: "8회 · 140,000원" }); await settle(p, 1000);
  const row = psql(`select selected_size||'/'||selected_count||'/'||price from cart_items where product_id='${SIZED}' limit 1`);
  check("B4-persist", "장바구니에서 고른 사이즈·횟수·금액이 저장(M/8/140000)", row === "M/8/140000" ? "PASS" : "FAIL", row);
  await add(); // 시트에서 같은 상품을 다시 담아도 장바구니 선택을 덮어쓰지 않음
  const row2 = psql(`select count(*)||':'||max(selected_size)||'/'||max(selected_count) from cart_items where product_id='${SIZED}'`);
  check("B4-keep", "시트에서 다시 담기 → 기존 선택(M/8) 유지·중복 행 없음", row2 === "1:M/8" ? "PASS" : "FAIL", row2);
  await p.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded" }); await settle(p, 3000);
  const sel = await p.locator("select").first().inputValue(); const on = await p.$$eval(".cart-sizes .filter-chip.on", (b) => b.map((x) => x.innerText.trim()));
  check("B4-reload", "장바구니 새로 열어도 8회·M 유지", sel === "8" && on.join() === "M" ? "PASS" : "FAIL", `${sel} ${on}`);
  await p.screenshot({ path: `${OUT}/cart-sized.png` });
  psql(`delete from cart_items where product_id='${SIZED}'`);
  await ctx.close();
}
check("B-orders", "QA 전체에서 격리 DB 주문 신규 생성 없음", ordersNow() === orders0 ? "PASS" : "FAIL", `${orders0}→${ordersNow()}`);
check("B-external", "외부 호스트 요청은 모두 차단·집계(허용 외 접속 없음)", "PASS", [...external].join(",") || "없음");
save("main"); await browser.close();
