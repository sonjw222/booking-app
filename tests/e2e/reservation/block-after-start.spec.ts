import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  insertConfirmedReservationAdmin,
  reservationDeepLink,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { selectKstCalendarDay, waitForToastText } from "../fixtures/pageHelpers";

/*
  "수업 시작 후" 예약/취소 차단 — 마감 설정과 무관하게, 수업이 이미 시작됐으면 서버가
  무조건 막아야 한다(reserve_class()/cancel_reservation() 양쪽 다).
  수업 start_time을 과거로 "되돌릴" 방법이 없으므로(테스트 계정으로 실제 시간이 흐르길
  기다리는 것 외에는 조작 수단이 없음), 몇 초 뒤 시작하는 짧은 수업을 만들고 실제로 그
  시각이 지날 때까지 기다린 뒤 클릭한다(tests/integration/reserve-class-block-after-start.test.ts와
  동일하게 이미 검증된 방식). Node 쪽 픽스처는 admin client로만 만든다(이유:
  tests/e2e/fixtures/testData.ts 파일 상단 설명 — 브라우저 세션 무효화 방지).
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let membershipId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  originalSettings = await fetchSettingsAdmin(centerAId);
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    groupCancelDaysBefore: 0,
    groupCancelTime: "23:59",
    allowSameDayBooking: true,
    dailyBookLimitEnabled: false,
  });
  const membership = await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
  membershipId = membership.id;
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("수업 시작 후 예약 시도 → 실패 확인 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 시작후예약차단", hoursFromNow: 8 / 3600, // 약 8초 뒤 시작
  });
  createdClassIds.push(cls.id);

  await page.waitForTimeout(12_000); // 수업 시작 시각을 확실히 지나도록 대기

  await page.goto(reservationDeepLink(cls.id, cls.startTime));
  await page.getByRole("button", { name: "예약하기" }).click();
  // 실패 시 모달이 안 닫히는 것으로 먼저 확인하고, 정확한 사유는 waitForToastText
  // (locator.waitFor 기반, toast의 2.5초 자동소멸을 피함)로 확정한다.
  await expect(page.locator(".sheet-overlay")).toBeVisible();
  const toastText = await waitForToastText(page);
  expect(toastText).toContain("수업이 시작되었습니다");
});

test("수업 시작 후 취소 시도 → 실패 확인 (실브라우저)", async ({ page }) => {
  const cls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 시작후취소차단", hoursFromNow: 8 / 3600,
  });
  createdClassIds.push(cls.id);

  // 시작 전에 먼저 예약을 만들어둔다(취소 대상 확보) — 이 예약 자체는 검증 대상이 아니다.
  await insertConfirmedReservationAdmin(cls.id, userA.profileId, { membershipId });

  await page.waitForTimeout(12_000); // 수업 시작 시각을 확실히 지나도록 대기

  await page.goto("/reservation");
  await selectKstCalendarDay(page, kstDateStr(cls.startTime));
  page.once("dialog", (d) => d.accept());
  const cancelButton = page.locator(".class-row", { hasText: "E2E 시작후취소차단" }).getByRole("button", { name: "취소" });
  await cancelButton.click();
  const toastText = await waitForToastText(page);
  expect(toastText).toContain("이미 시작되어 취소할 수 없어요");
  // 실패했으니 "취소" 버튼도 그대로 남아있어야 한다(상태가 안 바뀜).
  await expect(cancelButton).toBeVisible();
});
