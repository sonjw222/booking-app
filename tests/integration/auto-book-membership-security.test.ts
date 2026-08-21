/*
  SEC-114(P0) 회귀 테스트 — auto_book_membership() IDOR + 정책 회귀.

  ⚠ 이 파일은 fix_auto_book_membership_idor_draft_proposed.sql이 적용되기 전에는
  의도적으로 FAIL해야 한다(특히 AUTO-SEC-B/C/D/E — 지금은 전부 "성공"해버리는 게
  버그다). 적용 후 전부 green이어야 정상이다.

  fix_security_definer_hardening_search_path_execute_draft_proposed.sql은 이
  함수를 건드리지 않는다(auto_book_membership은 자기 전용 파일에서 EXECUTE까지
  같이 처리) — 이 테스트는 그 하드닝 배치와 무관하게 위 파일 하나만으로 검증된다.

  이 함수는 회원 self-service RPC가 아니라 "그 센터를 관리하는 사람(또는 플랫폼
  운영자)"만 쓰는 관리자 전용 기능이다(lib/classes.ts retryAutoBook, fulfill_order
  내부 호출 — 둘 다 호출 시점의 caller가 매니저다). 그래서 이 테스트의 "정상 경로"는
  MANAGER_A가 자기 센터 회원(USER_B)의 membership_id로 호출하는 것이고, USER_B
  본인이 자기 걸 직접 호출하는 것조차 거부돼야 하는 게 올바른 동작이다(AUTO-SEC-B).

  [2026-08-13 통합 정리] 이 파일은 canonical(B안, my_managed_center_ids() 기반) 테스트다.
  같은 문제를 다룬 다른 세션의 A안(has_permission 기반) 테스트에서 고유했던 커버리지 중
  AUTO-SEC-K(platform admin)/AUTO-SEC-L(fulfill_order end-to-end)을 이식했다. A안에만
  있던 "저권한 스태프는 거부돼야 한다"는 기대값은 이식하지 않았다 — my_managed_center_ids()
  모델은 권한 세분화 없이 "그 센터 소속 매니저면 누구나" 허용하는 게 의도된 설계이므로
  (fulfill_order/manager_set_attendance와 동일 패턴, 파일 상단 SQL 주석 참고) 그
  기대값 자체가 이 canonical 설계와 양립하지 않는다.
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  createFutureTestClass,
  createKstSameDayFutureClass,
  cleanupTestClassAdmin,
  requireEnv,
  type TestUser,
} from "./setup";
import { fetchSettings, saveSettings } from "../../lib/settings";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const USER_B = { email: "TEST_USER_B_EMAIL", password: "TEST_USER_B_PASSWORD" };

let managerA: TestUser;
let managerB: TestUser;
let userB: TestUser;
let centerAId: string;
let centerBId: string;

const cleanupClassIds: string[] = [];
const cleanupMembershipIds: string[] = [];
const cleanupProductIds: string[] = [];
const cleanupCenterIds: string[] = [];
const cleanupScheduleRuleProductIds: string[] = [];
const cleanupHolidays: Array<{ centerId: string; date: string }> = [];
let staleIsolatedCentersCleaned = false;

async function asManagerA() { return switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asManagerB() { return switchToTestUser(MANAGER_B.email, MANAGER_B.password); }
async function asUserB() { return switchToTestUser(USER_B.email, USER_B.password); }

// extract(dow from ...)와 동일한 규칙(0=일 ~ 6=토)으로 KST 기준 요일을 계산한다.
// kstSafeSameDayFutureTime()과 동일한 이유로 UTC 날짜 산술만 쓴다(호스트 타임존 무관).
function kstDow(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(iso));
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  const d = Number(parts.find((p) => p.type === "day")!.value);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function kstDateStr(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(iso));
}

function getAnonClient(): SupabaseClient {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function createAutoBookProduct(
  centerId: string, name: string, autoBookDays: number[]
): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("products")
    .insert({
      center_id: centerId, name: `${name}-${crypto.randomUUID()}`, product_kind: "pass", pass_type: "count",
      total_count: 999, is_on_sale: true, is_active: true, auto_book_days: autoBookDays,
      // [P2-25 수정] price 미설정 시 스키마 기본값 0으로 생성돼, AUTO-SEC-L이 만드는
      // orders.amount(10000)와 fulfill_order()의 가격 검증이 항상 불일치해 실패했다.
      price: 10000,
    })
    .select("id").single();
  if (error || !data) throw new Error(`자동예약용 상품 생성 실패: ${error?.message}`);
  cleanupProductIds.push(data.id);
  return { id: data.id };
}

async function createAutoBookMembership(
  centerId: string, profileId: string, productId: string,
  opts?: { remainingCount?: number }
): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const remaining = opts?.remainingCount ?? 3;
  const { data, error } = await admin
    .from("memberships")
    .insert({
      profile_id: profileId, center_id: centerId, product_id: productId,
      product_name: "SEC-114 자동예약 테스트 수강권", pass_type: "count",
      total_count: remaining, remaining_count: remaining, status: "active",
      expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    })
    .select("id").single();
  if (error || !data) throw new Error(`자동예약용 수강권 생성 실패: ${error?.message}`);
  cleanupMembershipIds.push(data.id);
  return { id: data.id };
}

async function createIsolatedOwnedCenter(manager: TestUser): Promise<string> {
  const admin = getFixtureAdminClient();
  // 중단된 이전 실행이 남긴 이 테스트 전용 센터를 먼저 정리한다. 일반/운영 센터와
  // 겹치지 않는 고유 접두사만 대상으로 한다. 같은 실행에서 만든 격리 센터들은 각
  // 테스트가 끝날 때까지 유지해야 하므로 이 정리는 파일 실행당 한 번만 수행한다.
  if (!staleIsolatedCentersCleaned) {
    staleIsolatedCentersCleaned = true;
    const { data: staleCenters, error: staleLookupError } = await admin
      .from("centers")
      .select("id")
      .like("name", "SEC-114 격리센터-%");
    if (staleLookupError) throw new Error(`이전 격리센터 조회 실패: ${staleLookupError.message}`);
    const staleIds = (staleCenters ?? []).map((center: any) => center.id as string);
    if (staleIds.length > 0) {
    const { data: staleClasses, error: staleClassLookupError } = await admin
      .from("classes").select("id").in("center_id", staleIds);
    if (staleClassLookupError) throw new Error(`이전 격리센터 수업 조회 실패: ${staleClassLookupError.message}`);
    const staleClassIds = (staleClasses ?? []).map((cls: any) => cls.id as string);
    const { data: staleMemberships, error: staleMembershipLookupError } = await admin
      .from("memberships").select("id").in("center_id", staleIds);
    if (staleMembershipLookupError) throw new Error(`이전 격리센터 수강권 조회 실패: ${staleMembershipLookupError.message}`);
    const staleMembershipIds = (staleMemberships ?? []).map((membership: any) => membership.id as string);
    if (staleClassIds.length > 0) {
      const { error } = await admin.from("reservations").delete().in("class_id", staleClassIds);
      if (error) throw new Error(`이전 격리센터 예약 정리 실패: ${error.message}`);
      const { error: classError } = await admin.from("classes").delete().in("id", staleClassIds);
      if (classError) throw new Error(`이전 격리센터 수업 정리 실패: ${classError.message}`);
    }
    // [P2-28 수정] AUTO-SEC-L이 fulfill_order()를 통해 실제 payments 행을 만들게 되면서
    // (격리 센터 전환 전에는 없던 경로) memberships 삭제가 payments_membership_id_fkey
    // 위반으로 실패하기 시작했다 — payments는 memberships/centers 둘 다에 FK가 있고 둘 다
    // ON DELETE CASCADE가 아니므로, memberships를 지우기 전에 먼저 지워야 한다.
    const { error: stalePaymentsDeleteError } = await admin.from("payments").delete().in("center_id", staleIds);
    if (stalePaymentsDeleteError) throw new Error(`이전 격리센터 결제 정리 실패: ${stalePaymentsDeleteError.message}`);
    if (staleMembershipIds.length > 0) {
      const { error } = await admin.from("reservations").delete().in("membership_id", staleMembershipIds);
      if (error) throw new Error(`이전 격리센터 수강권 예약 정리 실패: ${error.message}`);
      const { error: membershipError } = await admin.from("memberships").delete().in("id", staleMembershipIds);
      if (membershipError) throw new Error(`이전 격리센터 수강권 정리 실패: ${membershipError.message}`);
    }
    const { error: staleProductDeleteError } = await admin.from("products").delete().in("center_id", staleIds);
    if (staleProductDeleteError) throw new Error(`이전 격리센터 상품 정리 실패: ${staleProductDeleteError.message}`);
    const { error: staleLinkDeleteError } = await admin.from("manager_centers").delete().in("center_id", staleIds);
    if (staleLinkDeleteError) throw new Error(`이전 격리센터 관리자 연결 정리 실패: ${staleLinkDeleteError.message}`);
    const { error: staleRoleDeleteError } = await admin.from("center_roles").delete().in("center_id", staleIds);
    if (staleRoleDeleteError) throw new Error(`이전 격리센터 역할 정리 실패: ${staleRoleDeleteError.message}`);
    const { error: staleSettingsDeleteError } = await admin.from("center_settings").delete().in("center_id", staleIds);
    if (staleSettingsDeleteError) throw new Error(`이전 격리센터 설정 정리 실패: ${staleSettingsDeleteError.message}`);
      const { error: staleDeleteError } = await admin.from("centers").delete().in("id", staleIds);
      if (staleDeleteError) throw new Error(`이전 격리센터 정리 실패: ${staleDeleteError.message}`);
    }
  }
  // [P0-7/N/O 수정] status가 'approved'가 아니면 reserve_class() 등 여러 RPC가
  // "아직 승인되지 않은 센터예요"로 거부한다(예: fix_class_booking_deadline_override_
  // draft_proposed.sql). auto_book_membership()은 이 체크가 없어 F/G/I/J/K/L/M처럼
  // reserve_class를 거치지 않는 테스트는 문제없이 통과했지만, N/O는 "기존 예약" 준비
  // 단계에서 실제 reserve_class RPC를 호출하므로 격리 센터도 실제 운영 센터처럼
  // 승인된 상태여야 한다.
  const { data: center, error: centerError } = await admin
    .from("centers")
    .insert({ name: `SEC-114 격리센터-${crypto.randomUUID()}`, status: "approved" })
    .select("id")
    .single();
  if (centerError || !center) throw new Error(`격리센터 생성 실패: ${centerError?.message}`);

  const { data: ownerRole, error: roleError } = await admin
    .from("center_roles")
    .select("id")
    .eq("center_id", center.id)
    .eq("is_owner", true)
    .single();
  if (roleError || !ownerRole) throw new Error(`격리센터 오너 역할 조회 실패: ${roleError?.message}`);

  const { error: linkError } = await admin.from("manager_centers").insert({
    account_id: manager.accountId,
    center_id: center.id,
    role_id: ownerRole.id,
    status: "active",
  });
  if (linkError) throw new Error(`격리센터 관리자 연결 실패: ${linkError.message}`);
  cleanupCenterIds.push(center.id);
  return center.id;
}

async function fetchMembership(id: string) {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin.from("memberships").select("remaining_count").eq("id", id).single();
  if (error) throw new Error(`수강권 조회 실패: ${error.message}`);
  return data as { remaining_count: number | null };
}

async function fetchReservationsFor(membershipId: string) {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("reservations").select("id, profile_id, status, class_id").eq("membership_id", membershipId);
  if (error) throw new Error(`예약 조회 실패: ${error.message}`);
  return data ?? [];
}

// createFutureTestClass는 절대 오프셋이라 요일을 고를 수 없다 — 원하는 요일이 나올 때까지
// 7일 단위로 hoursFromNow를 밀어서 만든다(최대 6번 시도, 반드시 7일 이내에 걸림).
async function createClassOnDow(
  centerId: string, targetDow: number,
  opts?: { title?: string; baseHoursFromNow?: number }
): Promise<{ id: string; startTime: string }> {
  // classes INSERT는 매니저 권한이 필요하다 — 직전 테스트가 userB/managerB 세션으로
  // 끝났을 수 있으므로, 수업 생성 전에 명시적으로 managerA 세션을 확정한다.
  await asManagerA();
  const base = opts?.baseHoursFromNow ?? 72;
  for (let i = 0; i < 7; i++) {
    const hoursFromNow = base + i * 24;
    const cls = await createFutureTestClass(centerId, { title: opts?.title ?? "SEC-114 자동예약 테스트", hoursFromNow });
    if (kstDow(cls.startTime) === targetDow) return cls;
    await getFixtureAdminClient().from("classes").delete().eq("id", cls.id);
  }
  throw new Error("targetDow에 맞는 미래 수업을 7일 이내에 만들지 못했습니다");
}

beforeAll(async () => {
  managerA = await asManagerA();
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  managerB = await asManagerB();
  centerBId = await getOrCreateOwnedTestCenter(managerB);
  userB = await asUserB();
}, 60000);

// 이 파일의 여러 케이스가 같은 테스트 회원을 사용한다. 이전 케이스의 확정 예약이
// 남아 있으면 auto_book_membership()의 하루 1회 제한이 다음 케이스까지 막으므로,
// 각 케이스가 만든 예약과 수강권을 즉시 제거해 인증/정책 검증을 서로 격리한다.
afterEach(async () => {
  const ids = cleanupMembershipIds.splice(0);
  if (ids.length === 0) return;
  const admin = getFixtureAdminClient();
  const { error: reservationError } = await admin
    .from("reservations")
    .delete()
    .in("membership_id", ids);
  if (reservationError) throw new Error(`자동예약 테스트 예약 정리 실패: ${reservationError.message}`);
  const { error: membershipError } = await admin
    .from("memberships")
    .delete()
    .in("id", ids);
  if (membershipError) throw new Error(`자동예약 테스트 수강권 정리 실패: ${membershipError.message}`);
});

afterAll(async () => {
  await asManagerA();
  const errors: string[] = [];
  for (const classId of cleanupClassIds) {
    try { await cleanupTestClassAdmin(classId); } catch (e: any) { errors.push(e.message); }
  }
  const admin = getFixtureAdminClient();
  for (const productId of cleanupScheduleRuleProductIds) {
    try { await admin.from("membership_schedule_rules").delete().eq("product_id", productId); }
    catch (e: any) { errors.push(e.message); }
  }
  for (const h of cleanupHolidays) {
    try { await admin.from("center_holidays").delete().eq("center_id", h.centerId).eq("holiday_date", h.date); }
    catch (e: any) { errors.push(e.message); }
  }
  if (cleanupProductIds.length > 0) {
    try {
      const { error } = await admin.from("products").delete().in("id", cleanupProductIds);
      if (error) throw error;
    }
    catch (e: any) { errors.push(e.message); }
  }
  if (cleanupCenterIds.length > 0) {
    try {
      const { error: linkError } = await admin.from("manager_centers").delete().in("center_id", cleanupCenterIds);
      if (linkError) throw linkError;
      const { error: roleError } = await admin.from("center_roles").delete().in("center_id", cleanupCenterIds);
      if (roleError) throw roleError;
      const { error: settingsError } = await admin.from("center_settings").delete().in("center_id", cleanupCenterIds);
      if (settingsError) throw settingsError;
      const { error } = await admin.from("centers").delete().in("id", cleanupCenterIds);
      if (error) throw error;
    }
    catch (e: any) { errors.push(e.message); }
  }
  // 존재하지 않는 userA를 참조하던 중복 안전장치를 제거함(2026-08-18) — AUTO-SEC-K가
  // 이미 자체 try/finally로 userB의 is_platform_admin을 확실히 원복한다(테스트 본문
  // 참고). 이 줄은 그 리팩터 과정에서 변수명이 안 맞게 남아 tsc 컴파일 자체를 깨뜨리고
  // 있었다 — 실제로는 중복이라 로직 손실 없이 삭제.
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("SEC-114 AUTO-SEC-A~E: 권한 경계", () => {
  it("AUTO-SEC-A: 그 센터 매니저가 회원 수강권으로 호출하면 정상 자동예약된다", async () => {
    await asManagerA();
    const product = await createAutoBookProduct(centerAId, "SEC-114-A", [0, 1, 2, 3, 4, 5, 6]);
    const cls = await createClassOnDow(centerAId, new Date().getDay(), { title: "AUTO-SEC-A" });
    cleanupClassIds.push(cls.id);
    const mem = await createAutoBookMembership(centerAId, userB.profileId, product.id, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).toBeNull();
    expect((data as any).booked).toBeGreaterThanOrEqual(1);

    const after = await fetchMembership(mem.id);
    expect(after.remaining_count).toBe(3 - (data as any).booked);
    const res = await fetchReservationsFor(mem.id);
    expect(res.some((r) => r.profile_id === userB.profileId && r.status === "confirmed")).toBe(true);
  });

  it("AUTO-SEC-B: 수강권 소유자 본인(비매니저)이 직접 호출하면 거부된다", async () => {
    await asManagerA();
    const product = await createAutoBookProduct(centerAId, "SEC-114-B", [0, 1, 2, 3, 4, 5, 6]);
    const cls = await createClassOnDow(centerAId, new Date().getDay(), { title: "AUTO-SEC-B" });
    cleanupClassIds.push(cls.id);
    const mem = await createAutoBookMembership(centerAId, userB.profileId, product.id, { remainingCount: 3 });
    const before = await fetchMembership(mem.id);

    await asUserB();
    const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).not.toBeNull();

    const after = await fetchMembership(mem.id);
    expect(after.remaining_count).toBe(before.remaining_count);
    const res = await fetchReservationsFor(mem.id);
    expect(res.length).toBe(0);
  });

  it("AUTO-SEC-C: 로그인하지 않은(anon) 호출은 거부되고 어떤 변경도 일으키지 않는다", async () => {
    await asManagerA();
    const product = await createAutoBookProduct(centerAId, "SEC-114-C", [0, 1, 2, 3, 4, 5, 6]);
    const cls = await createClassOnDow(centerAId, new Date().getDay(), { title: "AUTO-SEC-C" });
    cleanupClassIds.push(cls.id);
    const mem = await createAutoBookMembership(centerAId, userB.profileId, product.id, { remainingCount: 3 });
    const before = await fetchMembership(mem.id);

    const anon = getAnonClient();
    const { data, error } = await anon.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).not.toBeNull();

    const after = await fetchMembership(mem.id);
    expect(after.remaining_count).toBe(before.remaining_count);
    const res = await fetchReservationsFor(mem.id);
    expect(res.length).toBe(0);
  });

  it("AUTO-SEC-D: 같은 계정의 다른(가족) 프로필 수강권도 본인 호출은 거부된다(정책: self-service 전면 불가)", async () => {
    const admin = getFixtureAdminClient();
    const { data: familyProfile, error: profErr } = await admin
      .from("profiles")
      .insert({ account_id: userB.accountId, name: "SEC-114 가족프로필", is_primary: false })
      .select("id").single();
    if (profErr || !familyProfile) throw new Error(`가족 프로필 생성 실패: ${profErr?.message}`);

    await asManagerA();
    const product = await createAutoBookProduct(centerAId, "SEC-114-D", [0, 1, 2, 3, 4, 5, 6]);
    const cls = await createClassOnDow(centerAId, new Date().getDay(), { title: "AUTO-SEC-D" });
    cleanupClassIds.push(cls.id);
    const mem = await createAutoBookMembership(centerAId, familyProfile.id, product.id, { remainingCount: 3 });
    const before = await fetchMembership(mem.id);

    await asUserB();
    const { error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).not.toBeNull();

    const after = await fetchMembership(mem.id);
    expect(after.remaining_count).toBe(before.remaining_count);
  });

  it("AUTO-SEC-E: 다른 센터 매니저가 남의 센터 membership_id로 호출하면 거부된다", async () => {
    await asManagerA();
    const product = await createAutoBookProduct(centerAId, "SEC-114-E", [0, 1, 2, 3, 4, 5, 6]);
    const cls = await createClassOnDow(centerAId, new Date().getDay(), { title: "AUTO-SEC-E" });
    cleanupClassIds.push(cls.id);
    const mem = await createAutoBookMembership(centerAId, userB.profileId, product.id, { remainingCount: 3 });
    const before = await fetchMembership(mem.id);

    await asManagerB();
    const { error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).not.toBeNull();

    const after = await fetchMembership(mem.id);
    expect(after.remaining_count).toBe(before.remaining_count);
  });
});

describe("SEC-114 AUTO-SEC-F~H: 정책 회귀(현대 예약 정책과의 정합)", () => {
  it("AUTO-SEC-F: membership_schedule_rules 불일치 요일/시간이면 자동예약되지 않는다", async () => {
    await asManagerA();
    // [P2-28 수정] 공유 센터(centerAId)를 쓰면 다른 파일/세션이 같은 센터에 동시에
    // 만드는 다른 'all' 모드 수업들이 auto_book_membership()의 스캔 범위에 섞여
    // booked=0 기대치가 깨진다(AUTO-SEC-G가 이미 이 이유로 격리 센터를 쓰는 것과 동일).
    const isolatedCenterId = await createIsolatedOwnedCenter(managerA);
    const product = await createAutoBookProduct(isolatedCenterId, "SEC-114-F", [0, 1, 2, 3, 4, 5, 6]);
    cleanupScheduleRuleProductIds.push(product.id);
    const cls = await createClassOnDow(isolatedCenterId, new Date().getDay(), { title: "AUTO-SEC-F" });
    cleanupClassIds.push(cls.id);
    const mismatchedDow = (kstDow(cls.startTime) + 1) % 7;
    const admin = getFixtureAdminClient();
    const { error: ruleErr } = await admin.from("membership_schedule_rules").insert({
      product_id: product.id, day_of_week: mismatchedDow, start_time: null, class_title: null,
    });
    if (ruleErr) throw new Error(`schedule_rule 추가 실패: ${ruleErr.message}`);
    const mem = await createAutoBookMembership(isolatedCenterId, userB.profileId, product.id, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).toBeNull();
    expect((data as any).booked).toBe(0);
    expect((await fetchMembership(mem.id)).remaining_count).toBe(3);
  });

  it("AUTO-SEC-G: pass_selection_mode='selected'인 수업에 이 상품이 지정돼 있지 않으면 자동예약되지 않는다", async () => {
    await asManagerA();
    // 공유 센터의 다른 '모든 수강권 허용' 수업이 자동예약 후보에 섞이지 않도록
    // 이 정책 케이스만 빈 격리 센터에서 검증한다.
    const isolatedCenterId = await createIsolatedOwnedCenter(managerA);
    const product = await createAutoBookProduct(isolatedCenterId, "SEC-114-G", [0, 1, 2, 3, 4, 5, 6]);
    const otherProduct = await createAutoBookProduct(isolatedCenterId, "SEC-114-G-다른상품", [0, 1, 2, 3, 4, 5, 6]);
    const dow = new Date().getDay();
    const cls = await createClassOnDow(isolatedCenterId, dow, { title: "AUTO-SEC-G" });
    cleanupClassIds.push(cls.id);
    await getFixtureAdminClient().from("classes").update({ pass_selection_mode: "selected" }).eq("id", cls.id);
    const mem = await createAutoBookMembership(isolatedCenterId, userB.profileId, product.id, { remainingCount: 3 });

    // class_allowed_products INSERT RLS는 매니저 세션이 필요하다(그 센터를 관리하는지 확인).
    await asManagerA();
    const { error: capErr } = await supabase
      .from("class_allowed_products").insert({ class_id: cls.id, product_id: otherProduct.id });
    if (capErr) throw new Error(`class_allowed_products 지정 실패: ${capErr.message}`);

    const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).toBeNull();
    expect((data as any).booked).toBe(0);
    expect((await fetchMembership(mem.id)).remaining_count).toBe(3);
  });

  it("AUTO-SEC-H: 센터 휴무일이면 그 날짜는 자동예약되지 않는다", async () => {
    await asManagerA();
    // [P2-28 수정] AUTO-SEC-F와 같은 이유(공유 센터 스캔 오염) — 격리 센터 사용.
    const isolatedCenterId = await createIsolatedOwnedCenter(managerA);
    const product = await createAutoBookProduct(isolatedCenterId, "SEC-114-H-휴무", [0, 1, 2, 3, 4, 5, 6]);
    const cls = await createClassOnDow(isolatedCenterId, new Date().getDay(), { title: "AUTO-SEC-H-휴무" });
    cleanupClassIds.push(cls.id);
    const holidayDate = kstDateStr(cls.startTime);
    const admin = getFixtureAdminClient();
    const { error: holErr } = await admin.from("center_holidays").insert({ center_id: isolatedCenterId, holiday_date: holidayDate });
    if (holErr) throw new Error(`휴무일 등록 실패: ${holErr.message}`);
    cleanupHolidays.push({ centerId: isolatedCenterId, date: holidayDate });
    const mem = await createAutoBookMembership(isolatedCenterId, userB.profileId, product.id, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).toBeNull();
    expect((data as any).booked).toBe(0);
    expect((await fetchMembership(mem.id)).remaining_count).toBe(3);
  });

  it("AUTO-SEC-H: 개별 수업 예약마감(booking_deadline_min)이 이미 지났으면 자동예약되지 않는다", async () => {
    await asManagerA();
    // [P2-28 수정] AUTO-SEC-F와 같은 이유(공유 센터 스캔 오염) — 격리 센터 사용.
    const isolatedCenterId = await createIsolatedOwnedCenter(managerA);
    const product = await createAutoBookProduct(isolatedCenterId, "SEC-114-H-마감", [0, 1, 2, 3, 4, 5, 6]);
    const cls = await createClassOnDow(isolatedCenterId, new Date().getDay(), { title: "AUTO-SEC-H-마감", baseHoursFromNow: 2 });
    cleanupClassIds.push(cls.id);
    // 수업이 2시간 뒤인데 마감을 "시작 300분(5시간) 전"으로 지정 → 마감 시각은 이미 3시간 전.
    const admin = getFixtureAdminClient();
    const { error: updErr } = await admin.from("classes").update({ booking_deadline_min: 300 }).eq("id", cls.id);
    if (updErr) throw new Error(`booking_deadline_min 설정 실패: ${updErr.message}`);
    const mem = await createAutoBookMembership(isolatedCenterId, userB.profileId, product.id, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).toBeNull();
    expect((data as any).booked).toBe(0);
    expect((await fetchMembership(mem.id)).remaining_count).toBe(3);
  });
});

describe("SEC-114 AUTO-SEC-I~J: 정상 동작 정확성", () => {
  it("AUTO-SEC-I: 정상 자동예약은 예약 수와 잔여횟수 차감이 정확히 일치한다", async () => {
    await asManagerA();
    const isolatedCenterId = await createIsolatedOwnedCenter(managerA);
    const dow = new Date().getDay();
    const product = await createAutoBookProduct(isolatedCenterId, "SEC-114-I", [dow]);
    const cls1 = await createClassOnDow(isolatedCenterId, dow, { title: "AUTO-SEC-I-1주차", baseHoursFromNow: 48 });
    const cls2 = await createClassOnDow(isolatedCenterId, dow, { title: "AUTO-SEC-I-2주차", baseHoursFromNow: 48 + 7 * 24 });
    cleanupClassIds.push(cls1.id, cls2.id);
    const mem = await createAutoBookMembership(isolatedCenterId, userB.profileId, product.id, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).toBeNull();
    const booked = (data as any).booked as number;
    expect(booked).toBe(2);

    const after = await fetchMembership(mem.id);
    expect(after.remaining_count).toBe(3 - booked);
    const res = await fetchReservationsFor(mem.id);
    expect(res.filter((r) => r.status === "confirmed")).toHaveLength(booked);
  });

  it("AUTO-SEC-J: 같은 수강권으로 다시 호출해도 중복 예약이나 초과 차감이 없다", async () => {
    await asManagerA();
    const isolatedCenterId = await createIsolatedOwnedCenter(managerA);
    const dow = new Date().getDay();
    const product = await createAutoBookProduct(isolatedCenterId, "SEC-114-J", [dow]);
    const cls = await createClassOnDow(isolatedCenterId, dow, { title: "AUTO-SEC-J", baseHoursFromNow: 96 });
    cleanupClassIds.push(cls.id);
    const mem = await createAutoBookMembership(isolatedCenterId, userB.profileId, product.id, { remainingCount: 3 });

    const first = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(first.error).toBeNull();
    const afterFirst = await fetchMembership(mem.id);

    const second = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(second.error).toBeNull();
    expect((second.data as any).booked).toBe(0);

    const afterSecond = await fetchMembership(mem.id);
    expect(afterSecond.remaining_count).toBe(afterFirst.remaining_count);
    const res = await fetchReservationsFor(mem.id);
    expect(res.filter((r) => r.status === "confirmed")).toHaveLength((first.data as any).booked);
  });
});

describe("SEC-114 AUTO-SEC-K~L: platform admin 허용 + fulfill_order 내부 호출 회귀 (다른 세션의 A안 테스트에서 이식)", () => {
  it("AUTO-SEC-K: platform admin은 centerA와 아무 매니저 관계가 없어도 허용된다", async () => {
    await asUserB(); // userB는 centerA/centerB 어디에도 manager_centers 행이 없다
    const product = await createAutoBookProduct(centerAId, "SEC-114-K", [0, 1, 2, 3, 4, 5, 6]);
    const cls = await createClassOnDow(centerAId, new Date().getDay(), { title: "AUTO-SEC-K" });
    cleanupClassIds.push(cls.id);
    const mem = await createAutoBookMembership(centerAId, userB.profileId, product.id, { remainingCount: 3 });

    const admin = getFixtureAdminClient();
    const { error: elevateErr } = await admin
      .from("accounts")
      .update({ is_platform_admin: true })
      .eq("id", userB.accountId);
    if (elevateErr) throw new Error("platform admin 플래그 설정 실패: " + elevateErr.message);
    try {
      const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
      expect(error).toBeNull();
      expect((data as any).booked).toBeGreaterThanOrEqual(1);
    } finally {
      const { error: resetErr } = await admin
        .from("accounts")
        .update({ is_platform_admin: false })
        .eq("id", userB.accountId);
      if (resetErr) throw new Error("platform admin 플래그 원복 실패: " + resetErr.message);
    }
  });

  it("AUTO-SEC-L: 정상 fulfill_order(auto_book=true) → auto_book_membership 내부 호출이 REVOKE와 무관하게 정상 동작한다", async () => {
    await asManagerA();
    // fulfill_order()는 SECURITY DEFINER(owner=postgres)로 실행되므로 그 안의
    // perform auto_book_membership(...)은 REVOKE EXECUTE FROM PUBLIC/anon과 무관하게
    // owner 권한으로 계속 동작해야 한다 — 이 테스트가 그 회귀를 실제로 잡아낸다
    // (막혀 있다면 주문 자체는 성공하지만 자동예약/차감이 조용히 0으로 끝난다).
    // [P2-28 수정] 공유 센터를 쓰면 다른 leftover 수업이 섞여 total_count=999 기준
    // remaining_count=998 단정이 깨진다 — 격리 센터 사용.
    const isolatedCenterId = await createIsolatedOwnedCenter(managerA);
    const dow = new Date().getDay();
    const cls = await createClassOnDow(isolatedCenterId, dow, { title: "AUTO-SEC-L", baseHoursFromNow: 96 });
    cleanupClassIds.push(cls.id);
    const product = await createAutoBookProduct(isolatedCenterId, "SEC-114-L", [dow]);

    const admin = getFixtureAdminClient();
    const { data: order, error: orderErr } = await admin
      .from("orders")
      .insert({
        center_id: isolatedCenterId,
        profile_id: userB.profileId,
        product_id: product.id,
        product_name: "SEC-114-L",
        amount: 10000,
        pay_method: "card",
        status: "pending",
        auto_book: true,
      })
      .select("id")
      .single();
    if (orderErr || !order) throw new Error("AUTO-SEC-L 주문 생성 실패: " + orderErr?.message);

    const { data, error } = await supabase.rpc("fulfill_order", { p_order_id: (order as any).id });
    expect(error).toBeNull();
    expect((data as any)?.already_done).toBe(false);
    const newMembershipId = (data as any)?.membership_id as string;
    expect(newMembershipId).toBeTruthy();

    const after = await fetchMembership(newMembershipId);
    // products.total_count 기본값(스키마 기본 null 가능) 대신, createAutoBookProduct가
    // total_count=999로 만들므로 998이면 정확히 1회 자동예약·차감된 것.
    expect(after.remaining_count).toBe(998);

    const res = await fetchReservationsFor(newMembershipId);
    expect(res.some((r) => r.class_id === cls.id && r.status === "confirmed")).toBe(true);

    // [P2-28 수정] fulfill_order()가 만드는 membership은 다른 테스트처럼
    // cleanupMembershipIds로 자동 정리되지 않는다(직접 만든 게 아니라 RPC가 반환한
    // id라서). 이 membership은 실제 payments 행도 동반하는데(이 파일에서 유일하게),
    // payments FK 때문에 정리 안 하면 이 격리 센터를 afterAll이 지울 때도, 다음 실행이
    // createIsolatedOwnedCenter()의 stale-cleanup에서 이 leftover를 만났을 때도 실패한다.
    await admin.from("payments").delete().eq("membership_id", newMembershipId);
    await admin.from("reservations").delete().eq("membership_id", newMembershipId);
    await admin.from("memberships").delete().eq("id", newMembershipId);
  }, 30000);
});

describe("SEC-114 AUTO-SEC-M~P: 나머지 정책 회귀 커버리지(이번 배치에서 추가 — reserve_class와 동일 조건 실측)", () => {
  it("AUTO-SEC-M: selected 모드 + class_allowed_products에 지정된 product는 membership_schedule_rules 불일치와 무관하게 자동예약된다(P1-17 override)", async () => {
    await asManagerA();
    // [P2-28 수정] AUTO-SEC-F와 같은 이유(공유 센터 스캔 오염) — 격리 센터 사용.
    const isolatedCenterId = await createIsolatedOwnedCenter(managerA);
    const product = await createAutoBookProduct(isolatedCenterId, "SEC-114-M", [0, 1, 2, 3, 4, 5, 6]);
    cleanupScheduleRuleProductIds.push(product.id);
    const cls = await createClassOnDow(isolatedCenterId, new Date().getDay(), { title: "AUTO-SEC-M" });
    cleanupClassIds.push(cls.id);
    const mismatchedDow = (kstDow(cls.startTime) + 1) % 7;
    const admin = getFixtureAdminClient();
    const { error: ruleErr } = await admin.from("membership_schedule_rules").insert({
      product_id: product.id, day_of_week: mismatchedDow, start_time: null, class_title: null,
    });
    if (ruleErr) throw new Error(`schedule_rule 추가 실패: ${ruleErr.message}`);
    const { error: modeErr } = await admin.from("classes").update({ pass_selection_mode: "selected" }).eq("id", cls.id);
    if (modeErr) throw new Error(`pass_selection_mode 지정 실패: ${modeErr.message}`);
    // class_allowed_products INSERT RLS는 매니저 세션이 필요하다(그 센터를 관리하는지 확인).
    const { error: capErr } = await supabase
      .from("class_allowed_products").insert({ class_id: cls.id, product_id: product.id });
    if (capErr) throw new Error(`class_allowed_products 지정 실패: ${capErr.message}`);
    const mem = await createAutoBookMembership(isolatedCenterId, userB.profileId, product.id, { remainingCount: 3 });

    // 대조: AUTO-SEC-F와 동일한 schedule_rule 불일치 상황이지만, 여기서는 'selected' +
    // class_allowed_products 명시 지정이 있으므로 override로 예약이 성사돼야 한다
    // (F는 'all' 모드라 override가 없어 booked=0이 되는 것과 대비된다).
    const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).toBeNull();
    expect((data as any).booked).toBe(1);
    expect((await fetchMembership(mem.id)).remaining_count).toBe(2);
  });

  it("AUTO-SEC-N: center_settings.daily_book_limit에 이미 도달한 날짜는 자동예약을 건너뛴다", async () => {
    await asManagerA();
    // [P2-28 수정] 공유 센터(centerAId)를 쓰면 (a) 다른 leftover 수업이 스캔에 섞이고
    // (b) 이 테스트가 center_settings를 잠깐 바꾸는 동안 다른 세션의 동시 실행과
    // 충돌할 수 있다 — 격리 센터를 쓰면 둘 다 해결되고, 격리 센터는 afterAll에서
    // 통째로 삭제되므로 설정 원복도 불필요하다.
    const isolatedCenterId = await createIsolatedOwnedCenter(managerA);
    const originalSettings = await fetchSettings(isolatedCenterId);
    const existingCls = await createKstSameDayFutureClass(isolatedCenterId, { title: "AUTO-SEC-N-기존예약", preferredMinutesFromNow: 180 });
    cleanupClassIds.push(existingCls.id);
    const dow = kstDow(existingCls.startTime);
    const product = await createAutoBookProduct(isolatedCenterId, "SEC-114-N", [dow]);

    // [P0-7 계열 수정] createTestMembership()은 RLS가 걸린 일반 클라이언트로 insert한다 —
    // 공유 센터에서는 userB가 오랫동안 그 센터의 회원이라 통과했지만, 이 격리 센터는
    // 방금 만들어져 userB와 아무 관계가 없어 memberships INSERT RLS를 위반한다(실측:
    // "new row violates row-level security policy for table memberships"). 이 파일의
    // 다른 모든 테스트처럼 admin 클라이언트를 쓰는 createAutoBookMembership()으로 대체.
    await asUserB();
    await createAutoBookMembership(isolatedCenterId, userB.profileId, product.id, { remainingCount: 3 });
    const { error: bookErr } = await supabase.rpc("reserve_class", { p_class_id: existingCls.id, p_profile_id: userB.profileId });
    if (bookErr) throw new Error(`기존 예약 실패: ${bookErr.message}`);

    await asManagerA();
    await saveSettings(isolatedCenterId, { ...originalSettings, dailyBookLimitEnabled: true, dailyBookLimit: 1 });

    const autoCls = await createKstSameDayFutureClass(isolatedCenterId, { title: "AUTO-SEC-N-자동예약대상", preferredMinutesFromNow: 210 });
    cleanupClassIds.push(autoCls.id);
    const mem = await createAutoBookMembership(isolatedCenterId, userB.profileId, product.id, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).toBeNull();
    expect((data as any).booked).toBe(0);
    expect((await fetchMembership(mem.id)).remaining_count).toBe(3);
  });

  it("AUTO-SEC-O: center_settings.private_max_concurrent에 이미 도달한 시간대는 자동예약을 건너뛴다", async () => {
    await asManagerA();
    // [P2-28 수정] AUTO-SEC-N과 같은 이유(공유 센터 스캔 오염 + 동시 settings 변경 충돌) —
    // 격리 센터 사용, afterAll에서 통째로 삭제되므로 설정 원복 불필요.
    const isolatedCenterId = await createIsolatedOwnedCenter(managerA);
    const originalSettings = await fetchSettings(isolatedCenterId);
    // [P2-25 수정] classes INSERT는 매니저 RLS가 필요하다 — asUserB() 이후로 미루면
    // 회원 세션으로 수업을 생성하게 돼 RLS 위반으로 실패한다. managerA 세션인 채로
    // 먼저 만든다.
    const occupied = await createFutureTestClass(isolatedCenterId, { title: "AUTO-SEC-O-기존점유", classFormat: "private", hoursFromNow: 96 });
    cleanupClassIds.push(occupied.id);
    // [P0-7 계열 수정] AUTO-SEC-N과 같은 이유 — createTestMembership()은 RLS가 걸린 일반
    // 클라이언트라 방금 만든 격리 센터에 아무 관계 없는 userB에게는 memberships INSERT가
    // 막힌다. admin 클라이언트를 쓰는 createAutoBookMembership()으로 대체(요일 매칭은
    // reserve_class()가 신경 쓰지 않으므로 auto_book_days 값 자체는 무의미).
    const occupyingProduct = await createAutoBookProduct(isolatedCenterId, "SEC-114-O-기존", [0, 1, 2, 3, 4, 5, 6]);

    await asUserB();
    await createAutoBookMembership(isolatedCenterId, userB.profileId, occupyingProduct.id, { remainingCount: 3 });
    const { error: bookErr } = await supabase.rpc("reserve_class", { p_class_id: occupied.id, p_profile_id: userB.profileId });
    if (bookErr) throw new Error(`기존 프라이빗 예약 실패: ${bookErr.message}`);

    await asManagerA();
    await saveSettings(isolatedCenterId, { ...originalSettings, privateMaxConcurrentEnabled: true, privateMaxConcurrent: 1 });

    // occupied와 겹치는 시간대(같은 hoursFromNow=96 → start/end 거의 동일, 최소 60분 duration과
    // 비교하면 밀리초 단위 오차는 무시 가능하게 겹친다)에 두 번째 프라이빗 수업을 만든다.
    const target = await createFutureTestClass(isolatedCenterId, { title: "AUTO-SEC-O-자동예약대상", classFormat: "private", hoursFromNow: 96 });
    cleanupClassIds.push(target.id);
    const dow = kstDow(target.startTime);
    const product = await createAutoBookProduct(isolatedCenterId, "SEC-114-O", [dow]);
    const mem = await createAutoBookMembership(isolatedCenterId, managerA.profileId, product.id, { remainingCount: 3 });

    const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
    expect(error).toBeNull();
    expect((data as any).booked).toBe(0);
    expect((await fetchMembership(mem.id)).remaining_count).toBe(3);
  });

  it("AUTO-SEC-P: 예약 오픈 시각(calc_deadline 'open')이 아직 안 됐으면 자동예약되지 않는다", async () => {
    await asManagerA();
    const originalSettings = await fetchSettings(centerAId);
    try {
      // 수업을 5일 뒤로 만들고 오픈은 "수업 1일 전"으로 좁힌다 → 지금부터 수업 4일 전까지는
      // 아직 오픈 전이라 어떤 예약(자동예약 포함)도 불가능해야 한다.
      await saveSettings(centerAId, { ...originalSettings, groupOpenDaysBefore: 1, groupOpenTime: "00:00" });
      const cls = await createFutureTestClass(centerAId, { title: "AUTO-SEC-P", hoursFromNow: 120 });
      cleanupClassIds.push(cls.id);
      const dow = kstDow(cls.startTime);
      const product = await createAutoBookProduct(centerAId, "SEC-114-P", [dow]);
      const mem = await createAutoBookMembership(centerAId, userB.profileId, product.id, { remainingCount: 3 });

      const { data, error } = await supabase.rpc("auto_book_membership", { p_membership_id: mem.id });
      expect(error).toBeNull();
      expect((data as any).booked).toBe(0);
      expect((await fetchMembership(mem.id)).remaining_count).toBe(3);
    } finally {
      await asManagerA();
      await saveSettings(centerAId, originalSettings);
    }
  });
});
