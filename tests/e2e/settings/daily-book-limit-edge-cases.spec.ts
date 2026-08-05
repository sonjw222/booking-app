import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createKstSameDayFutureClassAdmin,
  cleanupTestClassAdmin,
  cleanupTodaysReservationsForProfile,
  insertConfirmedReservationAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MEMBER_AUTH_FILE, MEMBER_B_AUTH_FILE } from "../fixtures/authFiles";
import { selectKstCalendarDay, waitForToastText } from "../fixtures/pageHelpers";

/*
  P0-4: 일일 예약 횟수 제한을 "처음부터" 재검증하라는 요청 중, 기존
  settings/daily-book-limit.spec.ts가 다루지 않는 세 가지 실제 사용 시나리오를 추가로
  검증한다(관리자 설정 화면 자체의 온/오프 배선은 그 스펙이 이미 검증했으므로 여기서는
  fetchSettingsAdmin/saveSettingsAdmin으로 값만 맞추고 예약 쪽 동작에 집중한다).

  RPC 로직 확인(fix_class_deadline_overrides_same_day_toggle.sql, reserve_class/
  reserve_with_membership 공통):
    select count(*) from reservations r join classes c on c.id = r.class_id
    where r.profile_id = v_profile_id and c.center_id = v_class.center_id
      and (c.start_time at time zone 'Asia/Seoul')::date = v_local_date
      and r.status in ('confirmed', 'waitlisted')
  - profile_id + center_id + 날짜로만 집계 → 계정(프로필)별로 독립적이고, membership_id는
    아예 조건에 없어 "어느 수강권을 썼는지"와 무관하게 합산된다.
  - status가 confirmed/waitlisted인 것만 세므로 취소(cancelled)는 빠진다 → 취소하면 그만큼
    다시 예약할 수 있어야 한다.
  - waitlisted도 포함되므로 대기 등록도 한도를 채운다.
  이 세 가지를 실제 브라우저로 확인한다(코드로만 보고 끝내지 않음).
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let userB: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  userB = loadTestAccountMeta("user-b");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  originalSettings = await fetchSettingsAdmin(centerAId);
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 20 });
  await createTestMembershipAdmin(centerAId, userB.profileId, { remainingCount: 20 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("취소하면 그만큼 하루 한도가 다시 채워져 재예약이 가능하다 (실브라우저)", async ({ page }) => {
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    allowSameDayBooking: true,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    dailyBookLimitEnabled: true,
    dailyBookLimit: 1,
  });
  await cleanupTodaysReservationsForProfile(centerAId, userA.profileId);

  const cls1 = await createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 한도재충전 1", preferredMinutesFromNow: 30 });
  const cls2 = await createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 한도재충전 2", preferredMinutesFromNow: 45 });
  createdClassIds.push(cls1.id, cls2.id);

  await page.goto("/reservation");
  await selectKstCalendarDay(page, kstDateStr(cls1.startTime));

  // 1/1 — 성공
  await page.locator(".class-row", { hasText: "E2E 한도재충전 1" }).getByRole("button", { name: "예약" }).click();
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  await expect(page.locator(".class-row", { hasText: "E2E 한도재충전 1" }).getByRole("button", { name: "취소" })).toBeVisible();

  // 한도(1) 도달 — 2번째 수업은 실패해야 한다
  await page.locator(".class-row", { hasText: "E2E 한도재충전 2" }).getByRole("button", { name: "예약" }).click();
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toBeVisible();
  const blockedToast = await waitForToastText(page);
  expect(blockedToast).toContain("하루 예약 가능 횟수");
  // 모달만 닫기(취소 대상 없음) — .sheet-overlay는 화면 전체를 덮고 .sheet는 하단 85vh만
  // 차지하는 바텀시트라, 중앙을 클릭하면 시트 안쪽을 누르게 된다. 시트가 절대 닿지 않는
  // 좌상단 모서리를 좌표 지정으로 클릭해 백드롭(overlay 자신의 onClick)만 확실히 누른다.
  await page.locator(".sheet-overlay").click({ position: { x: 10, y: 10 } });

  // 1번 수업 취소 — 한도가 다시 비워진다
  page.once("dialog", (d) => d.accept());
  await page.locator(".class-row", { hasText: "E2E 한도재충전 1" }).getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".class-row", { hasText: "E2E 한도재충전 1" }).getByRole("button", { name: "예약" })).toBeVisible();

  // 이제 2번 수업 예약이 성공해야 한다(취소로 한도가 다시 채워졌으므로)
  await page.locator(".class-row", { hasText: "E2E 한도재충전 2" }).getByRole("button", { name: "예약" }).click();
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  await expect(page.locator(".class-row", { hasText: "E2E 한도재충전 2" }).getByRole("button", { name: "취소" })).toBeVisible();
});

test("대기 등록도 하루 한도에 포함된다 (실브라우저)", async ({ page }) => {
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    allowSameDayBooking: true,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    dailyBookLimitEnabled: true,
    dailyBookLimit: 1,
  });
  await cleanupTodaysReservationsForProfile(centerAId, userA.profileId);
  await cleanupTodaysReservationsForProfile(centerAId, userB.profileId);

  // 정원 1명짜리 수업을 만들고 userB로 먼저 채워, userA가 시도하면 대기(waitlisted)가 되도록 한다.
  const fullCls = await createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 한도대기 정원마감", preferredMinutesFromNow: 30, capacity: 1 });
  const openCls = await createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 한도대기 여유", preferredMinutesFromNow: 45 });
  createdClassIds.push(fullCls.id, openCls.id);
  await insertConfirmedReservationAdmin(fullCls.id, userB.profileId);

  await page.goto("/reservation");
  await selectKstCalendarDay(page, kstDateStr(fullCls.startTime));

  // 정원이 찼으므로 목록 버튼은 "예약"이 아니라 "대기"로 표시된다.
  await page.locator(".class-row", { hasText: "E2E 한도대기 정원마감" }).getByRole("button", { name: "대기" }).click();
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  const waitlistedRow = page.locator(".class-row", { hasText: "E2E 한도대기 정원마감" });
  await expect(waitlistedRow.getByText("대기중")).toBeVisible();
  await expect(waitlistedRow.getByRole("button", { name: "취소" })).toBeVisible();

  // 대기 등록 1건으로 이미 하루 한도(1)를 채웠으므로, 정원 여유가 있는 다른 수업도 막혀야 한다.
  await page.locator(".class-row", { hasText: "E2E 한도대기 여유" }).getByRole("button", { name: "예약" }).click();
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toBeVisible();
  const blockedToast = await waitForToastText(page);
  expect(blockedToast).toContain("하루 예약 가능 횟수");
});

test("회원 A와 회원 B의 하루 한도는 서로 독립적이다 (실브라우저)", async ({ page, browser }) => {
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    allowSameDayBooking: true,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    dailyBookLimitEnabled: true,
    dailyBookLimit: 1,
  });
  await cleanupTodaysReservationsForProfile(centerAId, userA.profileId);
  await cleanupTodaysReservationsForProfile(centerAId, userB.profileId);

  const cls = await createKstSameDayFutureClassAdmin(centerAId, { title: "E2E 계정독립 공용수업", preferredMinutesFromNow: 30, capacity: 8 });
  createdClassIds.push(cls.id);

  const userBContext = await browser.newContext({ storageState: MEMBER_B_AUTH_FILE });
  const userBPage = await userBContext.newPage();

  // 회원 A가 하루 한도(1)를 이미 채운다.
  await page.goto("/reservation");
  await selectKstCalendarDay(page, kstDateStr(cls.startTime));
  await page.locator(".class-row", { hasText: "E2E 계정독립 공용수업" }).getByRole("button", { name: "예약" }).click();
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  await expect(page.locator(".class-row", { hasText: "E2E 계정독립 공용수업" }).getByRole("button", { name: "취소" })).toBeVisible();

  // 같은 센터/같은 날짜라도 회원 B는 아직 0회이므로, 같은 수업(정원 여유 있음)을 예약해도
  // 성공해야 한다 — 회원 A의 카운트가 새어 들어가면 안 된다.
  await userBPage.goto("/reservation");
  await selectKstCalendarDay(userBPage, kstDateStr(cls.startTime));
  await userBPage.locator(".class-row", { hasText: "E2E 계정독립 공용수업" }).getByRole("button", { name: "예약" }).click();
  await userBPage.getByRole("button", { name: "예약하기" }).click();
  await expect(userBPage.locator(".sheet-overlay")).toHaveCount(0);
  await expect(userBPage.locator(".class-row", { hasText: "E2E 계정독립 공용수업" }).getByRole("button", { name: "취소" })).toBeVisible();

  await userBContext.close();
});
