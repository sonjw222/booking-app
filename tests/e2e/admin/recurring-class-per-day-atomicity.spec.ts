import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  cleanupTestClassAdmin,
  type TestUser,
} from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";
import { MANAGER_AUTH_FILE } from "../fixtures/authFiles";
import { expandRecurringDates } from "../../../lib/classes";

/*
  요일별 개별 지정(perDayMode) 반복수업 생성 회귀 테스트.

  배경(Track B 감사 P2-14, 2026-08-26 수정): perDayMode는 원래 선택한 요일마다
  createRecurringClasses(→ create_recurring_classes_safe RPC)를 따로 호출했다. RPC 자체는
  한 번의 insert로 원자적이지만, 요일 수만큼 별도 RPC 호출(=별도 트랜잭션)이 생겨 중간
  요일에서 실패하면 이전 요일들만 반영된 채 남는 문제가 있었다. 이제는 lib/classes.ts의
  createRecurringClassesPerDay()가 모든 요일의 행을 한 번에 모아 RPC를 단 한 번만 호출한다.

  이 테스트는 "실패 시 부분 반영" 자체를 재현하긴 어렵지만(정상 경로에서 실패를 유도할
  훅이 없음), 요일별로 다른 시간/정원 설정이 실제 UI 등록 한 번으로 정확히 저장되는지 —
  즉 리팩터링이 기존 요일별 지정 기능을 깨지 않았는지 — 실제 브라우저로 검증한다.
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let centerAId: string;
const createdClassIds: string[] = [];

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
});

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
});

function kstDateStrFromNow(daysFromNow: number): string {
  const future = new Date(Date.now() + daysFromNow * 24 * 3600 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(future);
}

function kstDow(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

test("요일별 개별 지정(perDayMode) 반복수업 등록 — RPC 1회로 모든 요일이 정확히 반영됨 (실브라우저)", async ({ page }) => {
  // 다른 테스트 파일들이 쓰는 근미래 날짜(최대 ~93일)와 겹치지 않도록 충분히 먼 미래를 쓴다.
  const fromDate = kstDateStrFromNow(150);
  const toDate = kstDateStrFromNow(163); // 2주 범위 — 서로 다른 두 요일이 각 2회씩 나옴
  const dowA = kstDow(fromDate);
  const dowB = kstDow(kstDateStrFromNow(151)); // fromDate 다음날 — dowA와 항상 다름
  const uniqueTitle = `PERDAY-ATOMIC-${Date.now()}`;
  const admin = getFixtureAdminClient();

  await page.goto("/manager/classes");
  await page.locator(".fab-btn", { hasText: "수업 등록" }).click();
  await expect(page.locator(".sheet-title", { hasText: "수업 등록" })).toBeVisible();

  await page.locator('input[placeholder="수업명"]').fill(uniqueTitle);

  // 매주 반복 등록 켜기
  await page.locator(".set-row", { hasText: "매주 반복 등록" }).locator(".switch").click();

  // 두 요일 선택
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  await page.locator(".filter-chip", { hasText: new RegExp(`^${WEEKDAYS[dowA]}$`) }).click();
  await page.locator(".filter-chip", { hasText: new RegExp(`^${WEEKDAYS[dowB]}$`) }).click();

  // 반복 기간
  const dateProxies = page.locator(".app-date-native-proxy");
  await dateProxies.nth(0).fill(fromDate);
  await dateProxies.nth(1).fill(toDate);

  // 앱의 save()와 동일하게 이 센터의 휴무일을 제외하고 기대값을 계산한다(원격 국경일
  // 테이블이 이 범위에 포함될 수 있어, 순수 expandRecurringDates만으로는 어긋날 수 있음).
  const { data: holidayRows } = await admin
    .from("center_holidays").select("holiday_date").eq("center_id", centerAId)
    .gte("holiday_date", fromDate).lte("holiday_date", toDate);
  const holidays = new Set((holidayRows ?? []).map((h: any) => h.holiday_date as string));
  const expectedDatesA = expandRecurringDates(fromDate, toDate, [dowA]).filter((d) => !holidays.has(d));
  const expectedDatesB = expandRecurringDates(fromDate, toDate, [dowB]).filter((d) => !holidays.has(d));
  test.skip(expectedDatesA.length === 0 || expectedDatesB.length === 0, "선택한 2주 범위가 전부 휴무일이라 이 실행에서는 검증 불가");
  await expect(page.locator(".rep-preview")).toContainText(`${expectedDatesA.length + expectedDatesB.length}개`);

  // 요일별로 다르게 켜고, 두 요일에 서로 다른 시간/정원 입력
  await page.locator(".set-row", { hasText: "요일별로 다르게" }).locator(".switch").click();
  await expect(page.locator(".perday-row")).toHaveCount(2);

  const rowA = page.locator(".perday-row", { hasText: `${WEEKDAYS[dowA]}요일` });
  await rowA.locator('input[type="time"]').nth(0).fill("09:00");
  await rowA.locator('input[type="time"]').nth(1).fill("10:00");
  await rowA.locator('input[placeholder="정원"]').fill("5");

  const rowB = page.locator(".perday-row", { hasText: `${WEEKDAYS[dowB]}요일` });
  await rowB.locator('input[type="time"]').nth(0).fill("18:00");
  await rowB.locator('input[type="time"]').nth(1).fill("19:30");
  await rowB.locator('input[placeholder="정원"]').fill("12");

  await page.getByRole("button", { name: "등록하기", exact: true }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);

  // 단 한 번의 RPC 호출로 두 요일 전부가 정확한 값으로 반영됐는지 admin client로 직접 확인
  const { data: rows, error } = await admin
    .from("classes")
    .select("id, start_time, end_time, capacity, recurring_group_id")
    .eq("center_id", centerAId)
    .eq("title", uniqueTitle);
  if (error) throw new Error(`생성된 반복수업 조회 실패: ${error.message}`);
  const created = rows ?? [];
  created.forEach((r) => createdClassIds.push(r.id));

  expect(created.length).toBe(expectedDatesA.length + expectedDatesB.length);
  // 전부 같은 recurring_group_id로 묶여야 함(요일이 달라도 하나의 등록으로 생성됐으므로)
  const groupIds = new Set(created.map((r) => r.recurring_group_id));
  expect(groupIds.size).toBe(1);

  const toKstHm = (iso: string) =>
    new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

  const rowsA = created.filter((r) => toKstHm(r.start_time) === "09:00");
  const rowsB = created.filter((r) => toKstHm(r.start_time) === "18:00");
  expect(rowsA.length).toBe(expectedDatesA.length);
  expect(rowsB.length).toBe(expectedDatesB.length);
  rowsA.forEach((r) => expect(r.capacity).toBe(5));
  rowsB.forEach((r) => expect(r.capacity).toBe(12));
});
