/* 시각 QA V01~V07 회귀(2026-10-25). 격리 PostgREST + 실제 JWT(회원 A / 센터 오너 M) + 로컬 Next dev. 운영 접속 없음, 외부 전송 없음.
   클래스 문자열이 아니라 실제 계산된 색 대비·위치·스크롤 구조를 검사한다. 라이트 = data-theme 없음(burgundy 기본), 다크 = charcoal.
   뷰포트는 page.setViewportSize 로 CSS 폭을 맞춘다(캡처 이미지 폭이 아니라 innerWidth 를 단언한다). */
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { U } from "./support";
import { seedVisualQa, cleanupVisualQa } from "./visualQaSeed";
import { loginAs } from "./uiLogin";

const SHOTS = process.env.SHOTS_DIR;
const THEMES = [["light", "burgundy"], ["dark", "charcoal"]] as const;
const SIZES: [number, number][] = [[320, 740], [390, 844], [767, 900], [768, 900], [1024, 900]];

async function useTheme(page: Page, theme: string) {
  await page.addInitScript((t) => { try { localStorage.setItem("app_theme", t); } catch { /* 무시 */ } }, theme);
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
/** 요소의 글자색과 "실제로 그 아래에 깔린" 배경색의 WCAG 대비. 배경은 조상들의 rgba 를 흰/검정 바탕 위에 합성한다. 그라디언트 배경이면 null. */
async function contrastOf(page: Page, selector: string, nth = 0): Promise<{ ratio: number; fg: string; bg: string } | null> {
  return page.locator(selector).nth(nth).evaluate((el) => {
    const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d")!;
    const rgba = (c: string): [number, number, number, number] => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const layers: [number, number, number, number][] = [];
    let node: Element | null = el; let gradient = false;
    while (node) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== "none" && node !== el) gradient = true;
      if (cs.backgroundImage && cs.backgroundImage !== "none" && node === el) gradient = true;
      const c = rgba(cs.backgroundColor); if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
      node = node.parentElement;
    }
    if (gradient) return null;
    let base: [number, number, number] = layers.length && layers[layers.length - 1][3] >= 1 ? [layers[layers.length - 1][0], layers[layers.length - 1][1], layers[layers.length - 1][2]] : [255, 255, 255];
    for (let i = layers.length - (layers[layers.length - 1]?.[3] >= 1 ? 2 : 1); i >= 0; i--) { const [r, g, b, a] = layers[i]; base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]; }
    const fgc = rgba(getComputedStyle(el).color);
    const fg: [number, number, number] = [fgc[0] * fgc[3] + base[0] * (1 - fgc[3]), fgc[1] * fgc[3] + base[1] * (1 - fgc[3]), fgc[2] * fgc[3] + base[2] * (1 - fgc[3])];
    const l1 = lum(fg), l2 = lum(base); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return { ratio: (hi + 0.05) / (lo + 0.05), fg: fg.map(Math.round).join(","), bg: base.map(Math.round).join(",") };
  });
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.beforeAll(() => seedVisualQa());
test.afterAll(() => cleanupVisualQa());


for (const [tn, theme] of THEMES) {
  test(`V01 [${tn}] 마이 수강권 카드의 프로필 배지가 읽히고 카드 밖으로 넘치지 않는다 (320/390/768/1024)`, async ({ page }) => {
    await useTheme(page, theme); await loginAs(page, U.A, "a@test.invalid");
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/mypage");
      const tag = page.locator(".membership-card .profile-tag").first();
      await expect(tag).toBeVisible({ timeout: 30_000 });
      const c = await contrastOf(page, ".membership-card .profile-tag");
      expect(c, `${tn} ${w}px 배지 대비 계산`).not.toBeNull();
      expect(c!.ratio, `${tn} ${w}px 배지 ${c!.fg} on ${c!.bg}`).toBeGreaterThanOrEqual(4.5);
      const box = await page.locator(".membership-card").first().boundingBox();
      for (let i = 0; i < await page.locator(".membership-card .profile-tag").count(); i++) {
        const tb = await page.locator(".membership-card .profile-tag").nth(i).boundingBox();
        const cardBox = await page.locator(".membership-card").nth(i).boundingBox();
        expect(tb!.x + tb!.width, `${w}px 배지 오른쪽 경계`).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
      }
      expect(box).not.toBeNull();
      expect(await noOverflow(page), `${tn} ${w}px 페이지 가로 넘침`).toBe(true);
      if (w === 390 || w === 1024) await shot(page, `V01-mypage-${w}-${tn}`);
    }
  });

  test(`V02 [${tn}] 구매 내역 선택 필터(.filter-chip.on) 대비 4.5:1 이상, 전체/수강권/상품 전환 후에도 유지`, async ({ page }) => {
    await useTheme(page, theme); await loginAs(page, U.A, "a@test.invalid");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/purchases");
    await expect(page.locator(".filter-chip.on").first()).toBeVisible({ timeout: 30_000 });
    for (const label of ["전체", "수강권", "상품", "전체"]) {
      const chip = page.getByRole("button", { name: label, exact: true }).first();
      if (await chip.count()) await chip.click();
      const c = await contrastOf(page, ".filter-chip.on");
      expect(c, `${tn} ${label}`).not.toBeNull();
      expect(c!.ratio, `${tn} ${label} ${c!.fg} on ${c!.bg}`).toBeGreaterThanOrEqual(4.5);
    }
    await shot(page, `V02-purchases-390-${tn}`);
    // 같은 토큰을 쓰는 다른 선택 칩(스킬 칩 등)도 같은 짝: 전역 토큰 확인
    const tokens = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); return [cs.getPropertyValue("--action-bg").trim(), cs.getPropertyValue("--on-action").trim()]; });
    expect(tokens[1].toLowerCase().replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3")).toBe("#ffffff");   // --on-action = 흰색(축약 표기 허용)
  });

  test(`V03 [${tn}] 관리자 매출 요약 라벨(순매출 / 기간 내 수업매출 합계)이 카드 위에서 읽히고 금액보다 약하다`, async ({ page }) => {
    await useTheme(page, theme); await loginAs(page, U.M, "m@test.invalid");
    for (const [path, label] of [["/manager/sales", "순매출"], ["/manager/class-revenue", "기간 내 수업매출 합계"]] as const) {
      for (const [w, h] of [[390, 844], [1024, 900]] as [number, number][]) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(path);
        const lbl = page.locator(".sales-big-label", { hasText: label }).first();
        await expect(lbl).toBeVisible({ timeout: 30_000 });
        const c = await contrastOf(page, ".sales-big-label");
        expect(c, `${path} ${tn}`).not.toBeNull();
        expect(c!.ratio, `${path} ${tn} ${w}px ${c!.fg} on ${c!.bg}`).toBeGreaterThanOrEqual(4.5);
        const val = await contrastOf(page, ".sales-big-value");
        expect(val!.ratio).toBeGreaterThanOrEqual(c!.ratio - 0.01);            // 금액이 라벨보다 흐리지 않다(위계)
        const lb = await lbl.boundingBox(); const vb = await page.locator(".sales-big-value").first().boundingBox();
        expect(lb!.y).toBeLessThan(vb!.y);                                      // 라벨이 금액 위
        if (w === 390) await shot(page, `V03-${path.split("/").pop()}-390-${tn}`);
      }
    }
  });

  test(`V04 [${tn}] 정산계좌: 모바일 좌우 gutter ≥14px, 데스크톱 패널 보존`, async ({ page }) => {
    await useTheme(page, theme); await loginAs(page, U.M, "m@test.invalid");
    for (const [w, h] of [[320, 740], [390, 844], [767, 900]] as [number, number][]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/manager/settlement");
      const bank = page.locator("#settlement-bank");
      await expect(bank).toBeVisible({ timeout: 30_000 });
      const b = await bank.boundingBox(); const save = await page.getByRole("button", { name: "저장", exact: true }).first().boundingBox();
      expect(b!.x, `${w}px 입력 왼쪽 여백`).toBeGreaterThanOrEqual(14);
      expect(w - (b!.x + b!.width), `${w}px 입력 오른쪽 여백`).toBeGreaterThanOrEqual(14);
      expect(save!.x + save!.width, `${w}px 저장 버튼`).toBeLessThanOrEqual(w - 14 + 1);
      const heading = await page.locator(".workspace-form-panel .menu-section-label").first().boundingBox();
      expect(Math.abs(heading!.x - b!.x), `${w}px 섹션 제목과 입력의 왼쪽 정렬`).toBeLessThanOrEqual(1);
      expect(await noOverflow(page)).toBe(true);
      if (w === 390) await shot(page, `V04-settlement-390-${tn}`);
    }
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/manager/settlement");
    const panel = page.locator(".workspace-form-panel").first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const pad = await panel.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    expect(pad).toBeGreaterThanOrEqual(24);                                    // 데스크톱 패널 padding 유지
    await shot(page, `V04-settlement-1024-${tn}`);
  });

  test(`V05 [${tn}] 일정 복사 시트: 취소/복사하기가 첫 화면에서 보이고 본문만 스크롤, 키보드로 도달 (320×740, 320×480)`, async ({ page }) => {
    await useTheme(page, theme); await loginAs(page, U.M, "m@test.invalid");
    for (const [w, h] of [[320, 740], [320, 480]] as [number, number][]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/manager/classes");
      await page.getByRole("button", { name: "일정 복사" }).click();
      const sheet = page.locator(".sheet.copy-sheet");
      await expect(sheet).toBeVisible({ timeout: 30_000 });
      await expect(sheet.locator(".copy-select-row").first()).toBeVisible({ timeout: 15_000 });
      const cancel = sheet.getByRole("button", { name: "취소", exact: true }), copy = sheet.getByRole("button", { name: "복사하기" });
      for (const btn of [cancel, copy]) { const bb = await btn.boundingBox(); expect(bb!.y + bb!.height, `${w}x${h} 버튼이 화면 안`).toBeLessThanOrEqual(h + 0.5); expect(bb!.y).toBeGreaterThanOrEqual(0); }
      // 스크롤 구조: 시트 자체는 스크롤하지 않고 본문 한 곳만 스크롤한다. 목록은 독립 스크롤이 아니다.
      const st = await page.evaluate(() => {
        const s = document.querySelector(".sheet.copy-sheet") as HTMLElement, b = s.querySelector(".copy-sheet-body") as HTMLElement, l = s.querySelector(".copy-select-list") as HTMLElement | null;
        return { sheetOverflow: getComputedStyle(s).overflowY, sheetScrollable: s.scrollHeight > s.clientHeight + 1, bodyScrollable: b.scrollHeight > b.clientHeight + 1, listOverflow: l ? getComputedStyle(l).overflowY : "none", sheetInView: s.getBoundingClientRect().bottom <= innerHeight + 0.5 };
      });
      expect(st.sheetScrollable, "시트 외곽은 스크롤하지 않는다").toBe(false);
      expect(st.listOverflow, "목록은 독립 스크롤 영역이 아니다").not.toBe("auto");
      expect(st.sheetInView).toBe(true);
      if (h === 480) expect(st.bodyScrollable, "짧은 높이에서는 본문이 스크롤된다").toBe(true);
      // 미리보기 후(긴 결과)에도 footer 접근 가능
      await sheet.getByRole("button", { name: "미리보기" }).click();
      await expect(sheet.locator(".copy-preview, .copy-select-head").first()).toBeVisible();
      const bb2 = await copy.boundingBox(); expect(bb2!.y + bb2!.height).toBeLessThanOrEqual(h + 0.5);
      // 본문을 끝까지 스크롤해도 footer 는 그대로
      await sheet.locator(".copy-sheet-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const bb3 = await cancel.boundingBox(); expect(bb3!.y + bb3!.height).toBeLessThanOrEqual(h + 0.5);
      // 키보드: Tab 으로 취소 버튼에 도달, Enter 로 닫힘(복사는 실행하지 않음)
      await page.locator(".copy-sheet-body").evaluate((el) => (el as HTMLElement).focus());
      let reached = false;
      for (let i = 0; i < 80 && !reached; i++) { await page.keyboard.press("Tab"); reached = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() === "취소" && !!document.activeElement?.closest(".copy-sheet-footer")); }
      expect(reached, "Tab 으로 취소 버튼 도달").toBe(true);
      if (h === 740) await shot(page, `V05-copy-320-${tn}`);
      await page.keyboard.press("Enter");
      await expect(sheet).toHaveCount(0);
    }
  });

  test(`V06 [${tn}] 플랫폼 구독 화면 제목이 "플랫폼 구독"이고 다른 관리자 경로 제목은 그대로`, async ({ page }) => {
    await useTheme(page, theme); await loginAs(page, U.M, "m@test.invalid");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/manager/subscription");
    await expect(page.locator("h1").first()).toHaveText("플랫폼 구독", { timeout: 30_000 });
    await shot(page, `V06-subscription-390-${tn}`);
    await page.goto("/manager/settlement");
    await expect(page.locator("h1").first()).toHaveText("정산계좌", { timeout: 30_000 });
  });

  test(`V07 [${tn}] 데스크톱 홈 종목 9개: 고립 없이 균형 배치(768/1024/1280/1440), 모바일은 8개+전체 종목`, async ({ page }) => {
    await useTheme(page, theme);
    for (const [w, h] of [[768, 900], [1024, 900], [1280, 900], [1440, 900]] as [number, number][]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      await expect(page.locator(".cat-item")).toHaveCount(9, { timeout: 30_000 });
      const rows = await page.locator(".cat-item").evaluateAll((els) => { const m = new Map<number, number>(); for (const e of els) { const t = Math.round(e.getBoundingClientRect().top); m.set(t, (m.get(t) ?? 0) + 1); } return [...m.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]); });
      expect(rows.reduce((a, b) => a + b, 0), `${w}px 보이는 종목 수`).toBe(9);
      if (rows.length > 1) { expect(Math.min(...rows), `${w}px 줄별 개수 ${rows.join("+")}`).toBeGreaterThanOrEqual(2); expect(Math.max(...rows) - Math.min(...rows), `${w}px 균형 ${rows.join("+")}`).toBeLessThanOrEqual(1); }
      const touch = await page.locator(".cat-item").first().boundingBox(); expect(touch!.width).toBeGreaterThanOrEqual(44); expect(touch!.height).toBeGreaterThanOrEqual(44);
      expect(await noOverflow(page)).toBe(true);
      if (w === 1024) await shot(page, `V07-home-1024-${tn}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.locator(".cat-item")).toHaveCount(8, { timeout: 30_000 });             // 모바일 기본 8개 정책 유지
    await expect(page.getByRole("button", { name: "전체 종목" })).toBeVisible();
    await page.getByRole("button", { name: "전체 종목" }).click();
    await expect(page.locator(".cat-item")).toHaveCount(9);
  });
}
