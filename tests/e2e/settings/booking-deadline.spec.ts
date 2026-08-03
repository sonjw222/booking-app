import { test, expect } from "@playwright/test";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createTestMembership,
  createFutureTestClassWithDeadlines,
  cleanupTestClass,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import { fetchSettings, saveSettings, type CenterSettings } from "../../../lib/settings";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  예약 가능 기한(마감) 검증 — "N시간 전" 정밀도는 운영설정의 요일 단위(N일 전 HH:MM)로는
  표현할 수 없고, 수업별 개별 예약마감 override(booking_deadline_min, 분 단위, CLASS-001)로만
  표현 가능하다는 것을 코드로 확인했다(lib/classes.ts/reserve_class()). 이 override 값
  자체는 수업 등록 폼(관리자 화면)에 이미 있는 필드이지만, 이 스펙에서는 fixture 생성을
  Node 쪽에서 지정하고(같은 값을 관리자 화면에서 넣어도 결과는 동일 — DB 컬럼이 같다),
  "그 값대로 회원 화면에서 실제로 예약 가능/불가가 갈리는지"를 브라우저로 검증하는 데
  집중한다.

  시나리오: 예약마감 = 수업 시작 2시간 전(booking_deadline_min=120)
    - 수업이 3시간 뒤 시작 → 지금은 마감(1시간 뒤) 이전이므로 예약 성공
    - 수업이 1시간 뒤 시작 → 마감(이미 1시간 전에 지남) 이후이므로 예약 실패
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

test.beforeAll(async () => {
  managerA = await switchToTestUser(process.env.TEST_MANAGER_A_EMAIL!, process.env.TEST_MANAGER_A_PASSWORD!);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  originalSettings = await fetchSettings(centerAId);
  // 운영설정 자체는 넉넉하게 열어둬 개별 수업 override만 결과에 영향을 주게 한다.
  await saveSettings(centerAId, {
    ...originalSettings,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    allowSameDayBooking: true,
    dailyBookLimitEnabled: false,
  });

  userA = await switchToTestUser(process.env.TEST_USER_A_EMAIL!, process.env.TEST_USER_A_PASSWORD!);
  await switchToTestUser(process.env.TEST_MANAGER_A_EMAIL!, process.env.TEST_MANAGER_A_PASSWORD!);
  await createTestMembership(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  await switchToTestUser(process.env.TEST_MANAGER_A_EMAIL!, process.env.TEST_MANAGER_A_PASSWORD!);
  for (const id of createdClassIds) await cleanupTestClass(id, []);
  await saveSettings(centerAId, originalSettings);
});

test("예약마감 2시간 전 — 3시간 뒤 수업은 예약 성공 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassWithDeadlines(centerAId, {
    title: "E2E 예약가능기한-성공", hoursFromNow: 3, bookingDeadlineMin: 120,
  });
  createdClassIds.push(cls.id);

  await page.goto(reservationDeepLink(cls.id, cls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".toast")).toContainText("예약이 완료됐어요");
});

test("예약마감 2시간 전 — 1시간 뒤 수업은 예약 실패 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassWithDeadlines(centerAId, {
    title: "E2E 예약가능기한-실패", hoursFromNow: 1, bookingDeadlineMin: 120,
  });
  createdClassIds.push(cls.id);

  await page.goto(reservationDeepLink(cls.id, cls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".toast")).toContainText("예약 마감시간이 지났어요");
});
