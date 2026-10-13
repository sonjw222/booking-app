import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createFutureTestClassAdmin,
  createKstSameDayFutureClassAdmin,
  cleanupTestClassAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  insertConfirmedReservationAdmin,
  ALWAYS_PAST_TODAY_TIME,
  ALWAYS_FUTURE_TODAY_TIME,
  kstDateStr,
  type TestUser,
} from "../../fixtures/testData";
import type { CenterSettings } from "../../../../lib/settings";
import { MEMBER_AUTH_FILE } from "../../fixtures/authFiles";
import { selectKstCalendarDay, waitForToastText } from "../../fixtures/pageHelpers";

/*
  Issue #210 Batch A/B — 내 예약(/my-reservations)·예약(/reservation) 취소 UX 신규 회귀 스펙.

  ⚠ 이 스펙은 "현재 앱의 결함을 드러내도록" 작성됐다. 아래 항목은 현재 구현에서 실패할 것으로 예상된다
  (코드 조사 근거 — app/my-reservations/page.tsx):
    A1 조회 오류가 빈 목록("예정된 예약이 없어요")으로 보이고 재시도 버튼이 없다(error-toast는 × 버튼만).
    A2 취소 버튼 이름이 전부 "취소"라 수업을 구별할 수 없다(aria-label 없음).
    A3 .toast에 role=status/aria-live가 없고, showToast의 setTimeout이 정리되지 않는다.
    A4 취소 확인창 문구가 항상 "이 수업 예약을 취소할까요?"라 차감/무료 여부를 미리 알리지 않는다.
  기대값을 현재 동작에 맞춰 느슨하게 하지 말 것 — 수정은 별도 후속 Issue(app/my-reservations/page.tsx, app/reservation/page.tsx).

  DEV fixture 한계: 서버 시간은 속이지 않는다. 마감 전/후는 센터 설정(groupCancelDaysBefore/Time)과 admin이 만든
  수업·예약(created_at 지정)으로만 만든다. 확인창에서는 "확인"을 누르지 않아 DB 변경이 없다(A3 토스트 테스트만
  마감 후·차감 꺼짐 상태로 "확인"을 눌러 서버가 거부하는 경로를 쓴다). 확인창 뒤 실제 차감 수치(deducted)는
  tests/integration/reservation-cancel-grace-period.test.ts 쪽 검증 영역이라 여기서는 다루지 않는다.
*/

test.use({ storageState: MEMBER_AUTH_FILE });

const TITLE_A = "E2E-210 요가 클래스";
const TITLE_B = "E2E-210 필라테스 클래스";
const TITLE_LATE = "E2E-210 마감후 수업";
const TITLE_FREE = "E2E-210 마감전 수업";
const TITLE_GRACE = "E2E-210 유예 수업";

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let membershipId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  originalSettings = await fetchSettingsAdmin(centerAId);
  await saveSettingsAdmin(centerAId, { ...originalSettings, allowSameDayBooking: true, dailyBookLimitEnabled: false });
  membershipId = (await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 })).id;
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

async function seedFutureReservation(title: string, hoursFromNow: number, createdMinutesAgo = 11) {
  const cls = await createFutureTestClassAdmin(centerAId, { title, hoursFromNow });
  createdClassIds.push(cls.id);
  await insertConfirmedReservationAdmin(cls.id, userA.profileId, { membershipId, createdAtIso: minutesAgo(createdMinutesAgo) });
  return cls;
}

async function setDark(page: Page, dark: boolean) {
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  await page.addInitScript((d) => { try { localStorage.setItem("app_theme", d ? "charcoal" : "burgundy"); } catch { /* noop */ } }, dark);
}

const row = (page: Page, title: string) => page.locator(".hist-item", { hasText: title });

/* ===================== Batch A-1: 조회 오류 vs 빈 목록 ===================== */
test.describe("A1 내 예약 조회 오류 처리", () => {
  test("정상 200 + 빈 목록은 빈 상태 안내이며 오류가 아니다", async ({ page }) => {
    await page.route("**/rest/v1/reservations*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
    await page.goto("/my-reservations");
    await expect(page.getByText("예정된 예약이 없어요")).toBeVisible();
    await expect(page.locator(".error-toast")).toHaveCount(0);
  });

  for (const status of [400, 500, 503]) {
    test(`조회 ${status} 실패는 빈 목록이 아니라 오류 안내+재시도를 보이고, 재시도 후 정상 데이터로 회복`, async ({ page }) => {
      await seedFutureReservation(TITLE_A, 30);
      let failing = true;
      await page.route("**/rest/v1/reservations*", (route) =>
        failing
          ? route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ message: "mock failure", code: "XX000" }) })
          : route.continue()
      );
      await page.goto("/my-reservations");
      // 오류를 빈 목록으로 간주하면 안 된다.
      await expect(page.getByText("예정된 예약이 없어요"), "오류인데 빈 목록 문구가 노출됨").toHaveCount(0);
      await expect(page.getByRole("alert").or(page.locator(".error-toast"))).toBeVisible();
      const retry = page.getByRole("button", { name: /다시 ?시도|재시도|다시 불러오기/ });
      await expect(retry, "재시도 버튼이 있어야 함").toBeVisible();

      failing = false;
      await retry.click();
      await expect(row(page, TITLE_A)).toBeVisible();
      await expect(page.locator(".error-toast")).toHaveCount(0);
    });
  }
});

/* ===================== Batch A-2/A-3: 접근성 이름·토스트 ===================== */
test.describe("A2/A3 취소 버튼 접근성 이름·토스트 공지", () => {
  test("복수 예약의 취소 버튼은 수업을 구별하는 접근성 이름을 가진다", async ({ page }) => {
    await seedFutureReservation(TITLE_A, 30);
    await seedFutureReservation(TITLE_B, 54);
    await page.goto("/my-reservations");
    const a = row(page, TITLE_A).locator("button.hist-cancel-btn");
    const b = row(page, TITLE_B).locator("button.hist-cancel-btn");
    await expect(a).toBeVisible();
    await expect(b).toBeVisible();
    const nameA = await a.evaluate((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim());
    const nameB = await b.evaluate((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim());
    expect(nameA, "버튼 이름이 서로 달라야 함").not.toBe(nameB);
    expect(nameA).toContain("요가");
    expect(nameB).toContain("필라테스");
    // role 기반으로도 접근 가능해야 한다.
    await expect(page.getByRole("button", { name: /요가.*취소|취소.*요가/ })).toHaveCount(1);
  });

  test("취소가 서버에서 거부될 때 뜨는 토스트는 스크린리더에 공지된다(role=status/alert 또는 aria-live)", async ({ page }) => {
    // 마감 후 + 차감 꺼짐 → cancel_reservation이 거부하므로 DB는 변하지 않는다.
    await saveSettingsAdmin(centerAId, { ...originalSettings, allowSameDayBooking: true, dailyBookLimitEnabled: false, groupCancelDaysBefore: 0, groupCancelTime: ALWAYS_PAST_TODAY_TIME, deductOnLateCancel: false });
    const cls = await createKstSameDayFutureClassAdmin(centerAId, { title: TITLE_LATE, preferredMinutesFromNow: 60 });
    createdClassIds.push(cls.id);
    await insertConfirmedReservationAdmin(cls.id, userA.profileId, { membershipId, createdAtIso: minutesAgo(11) });
    await page.goto("/my-reservations");
    await row(page, TITLE_LATE).getByRole("button", { name: /취소/ }).click();
    await page.locator(".confirm-sheet").getByRole("button", { name: "확인" }).click();
    await waitForToastText(page);
    const live = await page.locator(".toast").first().evaluate((el) => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const role = n.getAttribute("role");
        const al = n.getAttribute("aria-live");
        if (role === "status" || role === "alert" || al === "polite" || al === "assertive") return true;
      }
      return false;
    });
    expect(live, ".toast 또는 조상에 role=status/alert 또는 aria-live가 있어야 함").toBe(true);
  });

  test("정적 점검: showToast 타이머는 정리(clearTimeout)되어 겹침/언마운트 후 setState를 막는다", async () => {
    // 브라우저로 관측하기 어려운 항목(언마운트 후 setState는 React 18에서 경고도 없음)이라 소스를 직접 점검한다.
    const src = fs.readFileSync(path.resolve(process.cwd(), "app/my-reservations/page.tsx"), "utf-8");
    expect(src, "타이머 id를 보관하고 clearTimeout으로 정리해야 함").toContain("clearTimeout");
  });
});

/* ===================== Batch A-4/A-5: 취소 확정 전 차감/무료 안내 ===================== */
test.describe("A4/A5 취소 확인 전 차감·무료 안내", () => {
  async function openCancelDialogText(page: Page, title: string): Promise<string> {
    await page.goto("/my-reservations");
    await row(page, title).getByRole("button", { name: /취소/ }).click();
    const sheet = page.locator(".confirm-sheet");
    await expect(sheet).toBeVisible();
    return (await sheet.innerText()).replace(/\s+/g, " ");
    // "확인"은 누르지 않는다 — 테스트 종료 시 컨텍스트가 닫혀 DB 변경이 없다.
  }

  test("마감 후 + deduct_on_late_cancel=true: 확인 전에 '수강권 차감'을 알린다", async ({ page }) => {
    await saveSettingsAdmin(centerAId, { ...originalSettings, allowSameDayBooking: true, dailyBookLimitEnabled: false, groupCancelDaysBefore: 0, groupCancelTime: ALWAYS_PAST_TODAY_TIME, deductOnLateCancel: true });
    const cls = await createKstSameDayFutureClassAdmin(centerAId, { title: TITLE_LATE, preferredMinutesFromNow: 60 });
    createdClassIds.push(cls.id);
    await insertConfirmedReservationAdmin(cls.id, userA.profileId, { membershipId, createdAtIso: minutesAgo(11) });
    expect(await openCancelDialogText(page, TITLE_LATE)).toMatch(/차감/);
  });

  test("마감 후 + deduct_on_late_cancel=false: 확인 전에 '취소 불가(마감)'를 알린다", async ({ page }) => {
    await saveSettingsAdmin(centerAId, { ...originalSettings, allowSameDayBooking: true, dailyBookLimitEnabled: false, groupCancelDaysBefore: 0, groupCancelTime: ALWAYS_PAST_TODAY_TIME, deductOnLateCancel: false });
    const cls = await createKstSameDayFutureClassAdmin(centerAId, { title: TITLE_LATE, preferredMinutesFromNow: 60 });
    createdClassIds.push(cls.id);
    await insertConfirmedReservationAdmin(cls.id, userA.profileId, { membershipId, createdAtIso: minutesAgo(11) });
    expect(await openCancelDialogText(page, TITLE_LATE)).toMatch(/마감|취소(할 수)? 없|불가/);
  });

  test("마감 전(무료 취소 가능): 확인 전에 '차감 없음/무료'를 알린다", async ({ page }) => {
    await saveSettingsAdmin(centerAId, { ...originalSettings, allowSameDayBooking: true, dailyBookLimitEnabled: false, groupCancelDaysBefore: 0, groupCancelTime: ALWAYS_FUTURE_TODAY_TIME, deductOnLateCancel: true });
    const cls = await createKstSameDayFutureClassAdmin(centerAId, { title: TITLE_FREE, preferredMinutesFromNow: 180 });
    createdClassIds.push(cls.id);
    await insertConfirmedReservationAdmin(cls.id, userA.profileId, { membershipId, createdAtIso: minutesAgo(11) });
    expect(await openCancelDialogText(page, TITLE_FREE)).toMatch(/무료|차감(되지| 없)/);
  });

  test("예약 직후 10분 유예(마감 후여도 차감 없음): 확인 전에 '무료'를 알린다", async ({ page }) => {
    // created_at=지금(DB 기본 now와 동일 의미) → cancel_reservation의 10분 grace 대상. 서버 시간은 속이지 않는다.
    await saveSettingsAdmin(centerAId, { ...originalSettings, allowSameDayBooking: true, dailyBookLimitEnabled: false, groupCancelDaysBefore: 0, groupCancelTime: ALWAYS_PAST_TODAY_TIME, deductOnLateCancel: true });
    const cls = await createKstSameDayFutureClassAdmin(centerAId, { title: TITLE_GRACE, preferredMinutesFromNow: 60 });
    createdClassIds.push(cls.id);
    await insertConfirmedReservationAdmin(cls.id, userA.profileId, { membershipId, createdAtIso: new Date().toISOString() });
    expect(await openCancelDialogText(page, TITLE_GRACE)).toMatch(/유예|무료|차감(되지| 없)/);
  });

  test("수업 시작 후: 취소 버튼이 없고(예정/지난 어느 탭에도) 취소 가능으로 오인되지 않는다", async ({ page }) => {
    const cls = await createFutureTestClassAdmin(centerAId, { title: "E2E-210 시작후 수업", hoursFromNow: -1 });
    createdClassIds.push(cls.id);
    await insertConfirmedReservationAdmin(cls.id, userA.profileId, { membershipId, createdAtIso: minutesAgo(180) });
    await page.goto("/my-reservations");
    await expect(page.getByText("E2E-210 시작후 수업")).toHaveCount(0); // 예정 탭
    await page.getByRole("tab", { name: "지난 예약" }).or(page.getByRole("button", { name: "지난 예약" })).first().click();
    await expect(row(page, "E2E-210 시작후 수업")).toBeVisible();
    await expect(row(page, "E2E-210 시작후 수업").getByRole("button", { name: /취소/ })).toHaveCount(0);
  });

  test("A5 /reservation 과 /my-reservations 의 취소 확인 안내 문구가 일치한다", async ({ page }) => {
    await saveSettingsAdmin(centerAId, { ...originalSettings, allowSameDayBooking: true, dailyBookLimitEnabled: false, groupCancelDaysBefore: 0, groupCancelTime: ALWAYS_PAST_TODAY_TIME, deductOnLateCancel: true });
    const cls = await createKstSameDayFutureClassAdmin(centerAId, { title: TITLE_LATE, preferredMinutesFromNow: 60 });
    createdClassIds.push(cls.id);
    await insertConfirmedReservationAdmin(cls.id, userA.profileId, { membershipId, createdAtIso: minutesAgo(11) });

    const mine = await openCancelDialogText(page, TITLE_LATE);

    await page.goto("/reservation");
    await selectKstCalendarDay(page, kstDateStr(cls.startTime));
    await page.locator(".class-row", { hasText: TITLE_LATE }).getByRole("button", { name: "취소" }).click();
    const sheet = page.locator(".confirm-sheet");
    await expect(sheet).toBeVisible();
    const resv = (await sheet.innerText()).replace(/\s+/g, " ");
    expect(resv).toBe(mine);
  });
});

/* ===================== Batch B: 모바일·접근성(로그인 회원) ===================== */
const WIDTHS = [320, 360, 390];
const THEMES = [false, true]; // dark?

function parseRgb(s: string): [number, number, number, number] | null {
  const m = s.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
  if (!m) return null; // color(srgb ...) 등 → 미검증 처리
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}
const lum = ([r, g, b]: number[]) => {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

for (const width of WIDTHS) {
  for (const dark of THEMES) {
    const tag = `${width}px ${dark ? "dark" : "light"}`;
    test.describe(`B 로그인 회원 모바일 — ${tag}`, () => {
      test.beforeEach(async ({ page }) => {
        await setDark(page, dark);
        await page.setViewportSize({ width, height: 800 });
      });

      test("내 예약: 가로 넘침·취소/배지 겹침 없음, 취소 버튼 터치영역 44×44", async ({ page }) => {
        await seedFutureReservation(TITLE_A, 30);
        await seedFutureReservation(TITLE_B, 54);
        await page.goto("/my-reservations");
        await expect(row(page, TITLE_A)).toBeVisible();
        if (dark) await expect(page.locator("html")).toHaveAttribute("data-theme", "charcoal");

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, "가로 넘침").toBeLessThanOrEqual(1);

        for (const title of [TITLE_A, TITLE_B]) {
          const r = row(page, title);
          const btn = await r.locator(".hist-cancel-btn").evaluate((el) => { const b = el.getBoundingClientRect(); return { w: b.width, h: b.height, l: b.left, r: b.right }; });
          const badge = await r.locator(".hist-status").evaluate((el) => { const b = el.getBoundingClientRect(); return { t: b.top, bt: b.bottom, l: b.left, r: b.right }; });
          const btnTop = await r.locator(".hist-cancel-btn").evaluate((el) => el.getBoundingClientRect().top);
          expect(btn.w, `${title} 취소 버튼 너비`).toBeGreaterThanOrEqual(44);
          expect(btn.h, `${title} 취소 버튼 높이`).toBeGreaterThanOrEqual(44);
          expect(btn.l).toBeGreaterThanOrEqual(0);
          expect(btn.r).toBeLessThanOrEqual(width);
          expect(btnTop, "배지와 취소 버튼 세로 겹침").toBeGreaterThanOrEqual(badge.bt - 0.5);
          // 제목 텍스트가 오른쪽 영역을 침범하지 않는다.
          const regions = await r.evaluate((el) => {
            const title = el.querySelector(".hist-main")!.getBoundingClientRect();
            const actions = el.querySelector(".hist-right")!.getBoundingClientRect();
            // Narrow layouts put actions below the title; overlap requires intersection on BOTH axes.
            return { horizontal: Math.min(title.right, actions.right) - Math.max(title.left, actions.left),
              vertical: Math.min(title.bottom, actions.bottom) - Math.max(title.top, actions.top) };
          });
          expect(regions.horizontal <= 0.5 || regions.vertical <= 0.5,
            "제목 영역과 버튼 영역이 가로·세로 모두 겹치면 안 됨").toBe(true);
        }
      });

      test("내 예약: 취소 텍스트·상태 배지 대비(WCAG AA 4.5:1) — 계산 불가 색상 문법은 미검증", async ({ page }, testInfo) => {
        await seedFutureReservation(TITLE_A, 30);
        await page.goto("/my-reservations");
        await expect(row(page, TITLE_A)).toBeVisible();
        for (const sel of [".hist-cancel-btn", ".hist-status"]) {
          const m = await row(page, TITLE_A).locator(sel).evaluate((el) => {
            const fg = getComputedStyle(el).color;
            let bg = "rgba(0, 0, 0, 0)";
            for (let n: Element | null = el; n; n = n.parentElement) {
              const c = getComputedStyle(n).backgroundColor;
              if (!/rgba\(.*,\s*0\)$|transparent/.test(c)) { bg = c; break; }
            }
            if (bg === "rgba(0, 0, 0, 0)") bg = getComputedStyle(document.body).backgroundColor;
            return { fg, bg };
          });
          const fg = parseRgb(m.fg);
          const bg = parseRgb(m.bg);
          if (!fg || !bg || bg[3] < 1 || fg[3] < 1) {
            testInfo.annotations.push({ type: "미검증", description: `${tag} ${sel}: 색상 합성 불가 fg=${m.fg} bg=${m.bg}` });
            continue;
          }
          const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
          const ratio = (l1 + 0.05) / (l2 + 0.05);
          expect(ratio, `${tag} ${sel} 대비 ${ratio.toFixed(2)} (fg=${m.fg}, bg=${m.bg})`).toBeGreaterThanOrEqual(4.5);
        }
      });

      test("예약 화면: 가로 넘침 없음, 예약된 수업의 취소 버튼이 화면 안에 있고 44px 이상", async ({ page }) => {
        const cls = await seedFutureReservation(TITLE_A, 30);
        await page.goto("/reservation");
        await selectKstCalendarDay(page, kstDateStr(cls.startTime));
        const btn = page.locator(".class-row", { hasText: TITLE_A }).getByRole("button", { name: "취소" });
        await expect(btn).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, "가로 넘침").toBeLessThanOrEqual(1);
        const b = await btn.evaluate((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, l: r.left, r: r.right }; });
        expect(b.l).toBeGreaterThanOrEqual(0);
        expect(b.r).toBeLessThanOrEqual(width);
        expect(b.w, "취소 버튼 너비").toBeGreaterThanOrEqual(44);
        expect(b.h, "취소 버튼 높이").toBeGreaterThanOrEqual(44);
      });
    });
  }
}

test("B7 safe-area: viewport-fit=cover 일 때 하단 네비가 env(safe-area-inset-bottom)를 반영한다(정적 점검, 실기기 노치 렌더는 미검증)", async () => {
  const layout = fs.readFileSync(path.resolve(process.cwd(), "app/layout.tsx"), "utf-8");
  const css = fs.readFileSync(path.resolve(process.cwd(), "app/globals.css"), "utf-8");
  if (/viewport-?[fF]it/.test(layout)) expect(css).toContain("safe-area-inset-bottom");
  else test.info().annotations.push({ type: "미검증", description: "layout.tsx에 viewportFit 선언 없음 — safe-area는 네이티브 래퍼 의존, 웹 단독 검증 불가" });
});
