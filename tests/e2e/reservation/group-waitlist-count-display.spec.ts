import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createKstSameDayFutureClassAdmin,
  insertConfirmedReservationAdmin,
  cleanupTestClassAdmin,
  cleanupTodaysReservationsForProfile,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import type { CenterSettings } from "../../../lib/settings";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";
import { selectKstCalendarDay } from "../fixtures/pageHelpers";
import { getFixtureAdminClient } from "../../integration/setup";

/*
  운영설정 "회원에게 대기 인원 표시"(show_group_waitlist_count) 회귀 테스트.

  [2026-10-07 UI 정렬] 회원 목록 행의 `.class-count` "대기 N" 표시는 2026-10 예약 화면 개편으로 사라졌고, 같은 설정(show_group_waitlist_count)이 이제
  "예약하시겠어요?" 확인 시트의 `대기 N명`(confirm-class-sub)으로 표시된다(app/reservation/page.tsx). 이 스펙은 새 표시 위치에서 ON/OFF를 검증한다.
  대기 1명은 userB 계정의 임시 프로필에 admin으로 waitlisted 예약을 넣어 만든다(회원 userA는 시트를 열어 보기만 하고 예약하지 않는다).

  (이하 역사적 배경) 배경(TODO.md P2-17, 2026-08-27 재확인): 이 문서는 "표시 대상 UI 자체가 없어 미구현"이라고
  적혀 있었지만, 실제 코드(app/reservation/page.tsx의 `.class-count` "대기 {N}",
  lib/reservations.ts의 showWaitlistCount/waitlisted 배선)를 확인한 결과 이미 완전히
  구현·연결돼 있었다(문서 갱신 누락, 언제 구현됐는지는 이 조사만으로 불명). 회귀를 막기 위한
  자동 검증이 그동안 하나도 없었으므로 이번에 추가한다.
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let userB: TestUser;
let centerAId: string;
let originalSettings: CenterSettings;
const createdClassIds: string[] = [];
const tempProfileIds: string[] = [];

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  userB = loadTestAccountMeta("user-b");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  originalSettings = await fetchSettingsAdmin(centerAId);
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 20 });
  await cleanupTodaysReservationsForProfile(centerAId, userA.profileId);
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);   // 예약(임시 프로필의 대기 포함)을 먼저 지운다
  for (const id of tempProfileIds) await getFixtureAdminClient().from("profiles").delete().eq("id", id);
  await saveSettingsAdmin(centerAId, originalSettings);
});

test("대기 인원 표시 설정 ON/OFF에 따라 .class-count의 '대기 N'이 나타나고 사라진다 (실브라우저)", async ({ page }) => {
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    allowSameDayBooking: true,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    dailyBookLimitEnabled: false,
    waitlistWeeklyLimit: 999,
    showGroupWaitlistCount: true,
  });

  const title = `E2E 대기인원표시 ${Date.now()}`;
  const cls = await createKstSameDayFutureClassAdmin(centerAId, { title, preferredMinutesFromNow: 30, capacity: 1 });
  createdClassIds.push(cls.id);
  // 정원(1명)을 userB로 직접 채워, userA가 예약하면 곧바로 대기로 등록되게 한다.
  await insertConfirmedReservationAdmin(cls.id, userB.profileId);

  // 대기 1명: userB 계정의 임시 프로필(비대표)에 waitlisted 예약을 직접 넣는다.
  const { data: tmpProfile, error: tmpErr } = await getFixtureAdminClient()
    .from("profiles").insert({ account_id: userB.accountId, name: "E2E 대기인원 임시", is_primary: false }).select("id").single();
  if (tmpErr || !tmpProfile) throw new Error(`임시 프로필 생성 실패: ${tmpErr?.message ?? "no data"}`);
  tempProfileIds.push(tmpProfile.id);
  const { error: wlErr } = await getFixtureAdminClient().from("reservations").insert({ class_id: cls.id, profile_id: tmpProfile.id, status: "waitlisted" });
  if (wlErr) throw new Error(`대기 예약 생성 실패: ${wlErr.message}`);

  // userA가 확인 시트를 열어 대기 인원 표시를 본다(예약은 하지 않고 닫는다).
  async function openSheetAndReadWaitlistLine(): Promise<boolean> {
    await page.goto("/reservation");
    await selectKstCalendarDay(page, kstDateStr(cls.startTime));
    await page.locator(".class-row", { hasText: title }).getByRole("button", { name: "대기" }).click();
    await expect(page.locator(".sheet-title", { hasText: "예약하시겠어요?" })).toBeVisible();
    await expect(page.locator(".confirm-class-title", { hasText: title })).toBeVisible();
    const shown = (await page.locator(".confirm-class-sub", { hasText: /^대기 \d+명$/ }).count()) > 0;
    await page.locator(".sheet").getByRole("button", { name: "취소", exact: true }).click();
    await expect(page.locator(".sheet-overlay")).toHaveCount(0);
    return shown;
  }

  // 설정 ON: 대기 인원(1명)이 표시돼야 한다
  expect(await openSheetAndReadWaitlistLine()).toBe(true);

  // 설정 OFF: 인원수 표시가 사라져야 한다
  await saveSettingsAdmin(centerAId, {
    ...originalSettings,
    allowSameDayBooking: true,
    groupBookDaysBefore: 0,
    groupBookTime: "23:59",
    dailyBookLimitEnabled: false,
    waitlistWeeklyLimit: 999,
    showGroupWaitlistCount: false,
  });
  expect(await openSheetAndReadWaitlistLine()).toBe(false);
});
