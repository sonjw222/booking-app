import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  reservationDeepLink,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { waitForToastText } from "../fixtures/pageHelpers";

/*
  예약 가능 기한(마감) 검증 — "N시간 전" 정밀도는 운영설정의 요일 단위(N일 전 HH:MM)로는
  표현할 수 없고, 수업별 개별 예약마감 override(booking_deadline_min, 분 단위, CLASS-001)로만
  표현 가능하다는 것을 코드로 확인했다(lib/classes.ts/reserve_class()). 이 override 값
  자체는 수업 등록 폼(관리자 화면)에 이미 있는 필드이지만, 이 스펙에서는 fixture 생성을
  Node 쪽에서 admin client로 직접 지정하고(같은 값을 관리자 화면에서 넣어도 결과는 동일 —
  DB 컬럼이 같다), "그 값대로 회원 화면에서 실제로 예약 가능/불가가 갈리는지"를 브라우저로
  검증하는 데 집중한다. Node 쪽이 managerA/userA로 다시 로그인하지 않는 이유는
  tests/e2e/fixtures/testData.ts 파일 상단 설명 참고(브라우저 세션 무효화 방지).

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
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  originalSettings = await fetchSettingsAdmin(centerAId);
  // 운영설정 자체는 넉넉하게 열어둬 개별 수업 override만 결과에 영향을 주게 한다.
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    allowSameDayBooking: true,
    dailyBookLimitEnabled: false,
  });
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("예약마감 2시간 전 — 3시간 뒤 수업은 예약 성공 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 예약가능기한-성공", hoursFromNow: 3, bookingDeadlineMin: 120,
  });
  createdClassIds.push(cls.id);

  await page.goto(reservationDeepLink(cls.id, cls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  // toast(2.5초 자동소멸)를 기다리는 대신, 실제 상태 변화로 성공을 확인한다: 예약이
  // 성공하면 모달이 닫히고(doReserve의 setConfirmClass(null)) 그 수업 행이 "취소"
  // 버튼으로 바뀐다(다시 데이터를 불러온 뒤 mine=true가 됨).
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    page.locator(".class-row", { hasText: "E2E 예약가능기한-성공" }).getByRole("button", { name: "취소" })
  ).toBeVisible();
});

test("예약마감 2시간 전 — 1시간 뒤 수업은 예약 실패 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 예약가능기한-실패", hoursFromNow: 1, bookingDeadlineMin: 120,
  });
  createdClassIds.push(cls.id);

  await page.goto(reservationDeepLink(cls.id, cls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  // 실패 시 doReserve()의 catch 경로는 모달을 닫지 않으므로("실패했으니 다시 시도할 수
  // 있게") 모달이 계속 떠 있는지로 먼저 확인하고, 정확히 "왜" 실패했는지는 toast 문구로
  // 확정한다 — 2.5초 자동소멸을 피하기 위해 waitForToastText(locator.waitFor 기반)로
  // "나타나는 순간" 텍스트를 읽는다(임의 sleep이나 뒤늦은 폴링 없음).
  await expect(page.locator(".sheet-overlay")).toBeVisible();
  const toastText = await waitForToastText(page);
  expect(toastText).toContain("예약 마감시간이 지났어요");
});
