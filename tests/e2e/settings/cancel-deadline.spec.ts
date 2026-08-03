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
  kstTimeHHmm,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  예약 취소 기한(마감) 검증 — 처음에는 개별 수업 override(cancel_deadline_min)로 시도했으나,
  코드 추적 결과 이 컬럼은 사실상 죽어 있다: cancel_reservation()은 항상 운영설정
  calc_deadline('cancel')을 먼저 쓰고, 그게 null일 때만 이 컬럼을 보는데 center_settings가
  있는 한 calc_deadline은 절대 null이 아니다(fix_class_booking_deadline_override_draft_proposed.sql
  자체 주석에도 "cancel_deadline_min은 이번 범위에서 제외"라고 명시돼 있음). 게다가 이
  컬럼은 DB에서 NOT NULL DEFAULT 0이라 null을 넣으면 즉시 insert가 실패한다(첫 CI 실행에서
  실제로 발견됨). 그래서 이 스펙은 실제로 살아 있는 메커니즘인 운영설정
  (groupCancelDaysBefore=0 + groupCancelTime)으로 "지금부터 N분 뒤/전"이라는 절대 취소마감
  시각을 만들어 검증한다 — day 오프셋 0은 "그 수업이 속한 날의 그 시각"이므로, 오늘 안의
  수업이라면 어느 시각에 시작하든 이 절대 시각이 취소마감이 된다.

  예약 자체는(취소 대상을 만들기 위한 선행 조건일 뿐 이 테스트의 검증 대상이 아니므로) Node
  쪽에서 admin client로 직접 "확정 예약" 행을 만들고, created_at을 처음부터 과거로 지정해
  cancel_reservation()의 "예약 후 10분 그레이스" 예외를 애초에 피한다. Node가
  managerA/userA로 로그인하지 않는 이유는 tests/e2e/fixtures/testData.ts 파일 상단 설명
  참고(브라우저 세션 무효화 방지). "취소" 버튼 클릭과 그 결과 확인만 브라우저로 수행한다.
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
    allowSameDayBooking: true,
    dailyBookLimitEnabled: false,
    deductOnLateCancel: false, // 꺼져 있어야 마감 후 취소가 "차감 후 허용"이 아니라 진짜 차단됨
  });
  const membership = await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
  membershipId = membership.id;
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("취소마감이 5분 뒤(아직 안 지남) — 취소 성공 (실브라우저)", async ({ page }) => {
  await saveSettingsAdmin(centerAId, {
    ...(await fetchSettingsAdmin(centerAId)),
    groupCancelDaysBefore: 0,
    groupCancelTime: kstTimeHHmm(5), // 지금부터 5분 뒤 — 아직 마감 전
  });

  const cls = await createFutureTestClassAdmin(centerAId, { title: "E2E 취소기한-성공", hoursFromNow: 3 });
  createdClassIds.push(cls.id);
  await insertConfirmedReservationAdmin(cls.id, userA.profileId, {
    membershipId,
    createdAtIso: new Date(Date.now() - 11 * 60_000).toISOString(), // 10분 그레이스를 피하도록 11분 전으로 생성
  });

  await page.goto("/reservation");
  page.once("dialog", (d) => d.accept());
  await page.locator(".class-row", { hasText: "E2E 취소기한-성공" }).getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".toast")).toContainText("예약이 취소됐어요");
});

test("취소마감이 5분 전(이미 지남) — 취소 실패 (실브라우저)", async ({ page }) => {
  await saveSettingsAdmin(centerAId, {
    ...(await fetchSettingsAdmin(centerAId)),
    groupCancelDaysBefore: 0,
    groupCancelTime: kstTimeHHmm(-5), // 지금부터 5분 전 — 이미 마감 지남
  });

  const cls = await createFutureTestClassAdmin(centerAId, { title: "E2E 취소기한-실패", hoursFromNow: 3 });
  createdClassIds.push(cls.id);
  await insertConfirmedReservationAdmin(cls.id, userA.profileId, {
    membershipId,
    createdAtIso: new Date(Date.now() - 11 * 60_000).toISOString(),
  });

  await page.goto("/reservation");
  page.once("dialog", (d) => d.accept());
  await page.locator(".class-row", { hasText: "E2E 취소기한-실패" }).getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".toast")).toContainText("취소 마감시간이 지났어요");
});
