/*
  수업매출 캘린더 통합 테스트 — class_revenue_daily_summary / class_revenue_for_date /
  set_membership_session_amounts.

  공유 fixture 센터를 쓰지 않고 이 파일 전용 격리 센터를 매번 새로 만든다(2026-08-14/15
  세션에서 공유 센터 오염 때문에 하루 종일 겪은 문제를 반복하지 않기 위함 — 다른 세션의
  createIsolatedOwnedCenter 패턴을 그대로 채택).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser, getFixtureAdminClient, createFutureTestClass,
  type TestUser,
} from "./setup";
import {
  fetchClassRevenueDaily, fetchClassRevenueForDate, setMembershipSessionAmounts,
} from "../../lib/classRevenue";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const USER_B = { email: "TEST_USER_B_EMAIL", password: "TEST_USER_B_PASSWORD" };

let managerA: TestUser;
let managerB: TestUser;
let userB: TestUser;
let centerId: string;

const cleanupCenterIds: string[] = [];
let staleCleaned = false;

async function asManagerA() { return switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asManagerB() { return switchToTestUser(MANAGER_B.email, MANAGER_B.password); }
async function asUserB() { return switchToTestUser(USER_B.email, USER_B.password); }

function kstDateStr(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(iso));
}

// 이 파일 전용 격리 센터(다른 세션/파일과 데이터를 공유하지 않음).
async function createIsolatedCenter(manager: TestUser): Promise<string> {
  const admin = getFixtureAdminClient();
  if (!staleCleaned) {
    staleCleaned = true;
    const { data: stale } = await admin.from("centers").select("id").like("name", "CLASS-REV 격리센터-%");
    const staleIds = (stale ?? []).map((c: any) => c.id as string);
    if (staleIds.length > 0) {
      const { data: staleClasses } = await admin.from("classes").select("id").in("center_id", staleIds);
      const staleClassIds = (staleClasses ?? []).map((c: any) => c.id as string);
      if (staleClassIds.length > 0) {
        await admin.from("reservations").delete().in("class_id", staleClassIds);
        await admin.from("classes").delete().in("id", staleClassIds);
      }
      const { data: staleMemberships } = await admin.from("memberships").select("id").in("center_id", staleIds);
      const staleMembershipIds = (staleMemberships ?? []).map((m: any) => m.id as string);
      if (staleMembershipIds.length > 0) {
        await admin.from("membership_session_amounts").delete().in("membership_id", staleMembershipIds);
        await admin.from("payments").delete().in("membership_id", staleMembershipIds);
        await admin.from("reservations").delete().in("membership_id", staleMembershipIds);
        await admin.from("memberships").delete().in("id", staleMembershipIds);
      }
      await admin.from("products").delete().in("center_id", staleIds);
      await admin.from("manager_centers").delete().in("center_id", staleIds);
      await admin.from("center_roles").delete().in("center_id", staleIds);
      await admin.from("center_settings").delete().in("center_id", staleIds);
      await admin.from("centers").delete().in("id", staleIds);
    }
  }
  const { data: center, error: centerError } = await admin
    .from("centers").insert({ name: `CLASS-REV 격리센터-${crypto.randomUUID()}`, status: "pending" })
    .select("id").single();
  if (centerError || !center) throw new Error(`격리센터 생성 실패: ${centerError?.message}`);

  const { data: ownerRole, error: roleError } = await admin
    .from("center_roles").select("id").eq("center_id", center.id).eq("is_owner", true).single();
  if (roleError || !ownerRole) throw new Error(`격리센터 오너 역할 조회 실패: ${roleError?.message}`);

  const { error: linkError } = await admin.from("manager_centers").insert({
    account_id: manager.accountId, center_id: center.id, role_id: ownerRole.id, status: "active",
  });
  if (linkError) throw new Error(`격리센터 관리자 연결 실패: ${linkError.message}`);
  cleanupCenterIds.push(center.id);
  return center.id;
}

async function createProduct(kind: "pass" | "goods"): Promise<string> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin.from("products")
    .insert({ center_id: centerId, name: `CLASS-REV 테스트상품-${kind}-${crypto.randomUUID()}`, product_kind: kind })
    .select("id").single();
  if (error || !data) throw new Error(`상품 생성 실패: ${error?.message}`);
  return data.id;
}

async function createMembership(
  profileId: string, productId: string,
  opts: { passType: "count" | "period"; totalCount?: number | null }
): Promise<string> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin.from("memberships")
    .insert({
      profile_id: profileId, center_id: centerId, product_id: productId,
      product_name: "CLASS-REV 테스트수강권", pass_type: opts.passType,
      total_count: opts.totalCount ?? null, remaining_count: opts.totalCount ?? null,
      status: "active", expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    })
    .select("id").single();
  if (error || !data) throw new Error(`수강권 생성 실패: ${error?.message}`);
  return data.id;
}

async function createPayment(
  profileId: string, membershipId: string, amount: number,
  opts?: { saleType?: string; paidAt?: string }
): Promise<void> {
  const admin = getFixtureAdminClient();
  const { error } = await admin.from("payments").insert({
    center_id: centerId, profile_id: profileId, membership_id: membershipId,
    sale_type: opts?.saleType ?? "new", total_amount: amount,
    paid_at: opts?.paidAt ?? new Date().toISOString(), status: "paid",
  });
  if (error) throw new Error(`결제 생성 실패: ${error.message}`);
}

async function createReservation(classId: string, profileId: string, membershipId: string, status: string): Promise<void> {
  const admin = getFixtureAdminClient();
  const { error } = await admin.from("reservations").insert({ class_id: classId, profile_id: profileId, membership_id: membershipId, status });
  if (error) throw new Error(`예약 생성 실패: ${error.message}`);
}

beforeAll(async () => {
  managerA = await asManagerA();
  centerId = await createIsolatedCenter(managerA);
  managerB = await asManagerB();
  userB = await asUserB();
  await asManagerA(); // 이후 admin 아닌 일반 supabase 클라이언트로 classes를 만들 수 있게 매니저 세션 유지
}, 60000);

afterAll(async () => {
  const admin = getFixtureAdminClient();
  const errors: string[] = [];
  for (const id of cleanupCenterIds) {
    try {
      const { data: classes } = await admin.from("classes").select("id").eq("center_id", id);
      const classIds = (classes ?? []).map((c: any) => c.id as string);
      if (classIds.length > 0) {
        await admin.from("reservations").delete().in("class_id", classIds);
        await admin.from("classes").delete().in("id", classIds);
      }
      const { data: memberships } = await admin.from("memberships").select("id").eq("center_id", id);
      const membershipIds = (memberships ?? []).map((m: any) => m.id as string);
      if (membershipIds.length > 0) {
        await admin.from("membership_session_amounts").delete().in("membership_id", membershipIds);
        await admin.from("payments").delete().in("membership_id", membershipIds);
        await admin.from("reservations").delete().in("membership_id", membershipIds);
        await admin.from("memberships").delete().in("id", membershipIds);
      }
      await admin.from("products").delete().eq("center_id", id);
      await admin.from("manager_centers").delete().eq("center_id", id);
      await admin.from("center_roles").delete().eq("center_id", id);
      await admin.from("center_settings").delete().eq("center_id", id);
      await admin.from("centers").delete().eq("id", id);
    } catch (e: any) { errors.push(e.message); }
  }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("수업매출: 횟수제 균등분배 + no_show 포함 + 폐강 제외", () => {
  let productId: string;
  let membershipId: string;
  let dateA: string, dateB: string, dateC: string, dateCancelled: string;

  beforeAll(async () => {
    await asManagerA();
    productId = await createProduct("pass");
    membershipId = await createMembership(userB.profileId, productId, { passType: "count", totalCount: 3 });
    await createPayment(userB.profileId, membershipId, 10000);

    const clsA = await createFutureTestClass(centerId, { title: "CLASS-REV-A", hoursFromNow: 200 });
    const clsB = await createFutureTestClass(centerId, { title: "CLASS-REV-B", hoursFromNow: 224 });
    const clsC = await createFutureTestClass(centerId, { title: "CLASS-REV-C", hoursFromNow: 248 });
    const clsCancelled = await createFutureTestClass(centerId, { title: "CLASS-REV-CANCELLED", hoursFromNow: 272 });
    dateA = kstDateStr(clsA.startTime);
    dateB = kstDateStr(clsB.startTime);
    dateC = kstDateStr(clsC.startTime);
    dateCancelled = kstDateStr(clsCancelled.startTime);

    await createReservation(clsA.id, userB.profileId, membershipId, "confirmed");
    await createReservation(clsB.id, userB.profileId, membershipId, "attended");
    await createReservation(clsC.id, userB.profileId, membershipId, "no_show");
    await createReservation(clsCancelled.id, userB.profileId, membershipId, "confirmed");

    const admin = getFixtureAdminClient();
    const { error } = await admin.from("classes").update({ status: "cancelled" }).eq("id", clsCancelled.id);
    if (error) throw new Error(`수업 폐강 처리 실패: ${error.message}`);
  }, 30000);

  it("10000원/3회 = 회당 3334/3333/3333(나머지 앞회차 보정)으로 각 예약 날짜에 정확히 귀속된다", async () => {
    const [rowsA, rowsB, rowsC] = await Promise.all([
      fetchClassRevenueForDate(centerId, dateA),
      fetchClassRevenueForDate(centerId, dateB),
      fetchClassRevenueForDate(centerId, dateC),
    ]);
    const amtA = rowsA.filter((r) => r.type === "class").reduce((s, r) => s + r.amount, 0);
    const amtB = rowsB.filter((r) => r.type === "class").reduce((s, r) => s + r.amount, 0);
    const amtC = rowsC.filter((r) => r.type === "class").reduce((s, r) => s + r.amount, 0);
    expect(amtA + amtB + amtC).toBe(10000);
    expect([amtA, amtB, amtC].sort((x, y) => y - x)).toEqual([3334, 3333, 3333]);
  });

  it("no_show 예약도 매출에 포함된다(취소가 아니므로 실제 소모된 횟수)", async () => {
    const rows = await fetchClassRevenueForDate(centerId, dateC);
    const classRow = rows.find((r) => r.type === "class");
    expect(classRow).toBeDefined();
    expect(classRow!.amount).toBeGreaterThan(0);
  });

  it("폐강된(cancelled) 수업의 예약은 매출에서 빠진다", async () => {
    const rows = await fetchClassRevenueForDate(centerId, dateCancelled);
    expect(rows.filter((r) => r.type === "class")).toHaveLength(0);
  });

  it("회차별 금액을 비대칭으로 커스텀할 수 있고, 합계가 안 맞으면 거부된다", async () => {
    await expect(setMembershipSessionAmounts(membershipId, [5000, 3000])).rejects.toThrow(); // 길이 불일치
    await expect(setMembershipSessionAmounts(membershipId, [5000, 3000, 1000])).rejects.toThrow(); // 합계 9000 ≠ 10000

    await setMembershipSessionAmounts(membershipId, [5000, 3000, 2000]); // 합계 10000, 통과해야 함
    const [rowsA, rowsB, rowsC] = await Promise.all([
      fetchClassRevenueForDate(centerId, dateA),
      fetchClassRevenueForDate(centerId, dateB),
      fetchClassRevenueForDate(centerId, dateC),
    ]);
    const amtA = rowsA.filter((r) => r.type === "class").reduce((s, r) => s + r.amount, 0);
    const amtB = rowsB.filter((r) => r.type === "class").reduce((s, r) => s + r.amount, 0);
    const amtC = rowsC.filter((r) => r.type === "class").reduce((s, r) => s + r.amount, 0);
    expect([amtA, amtB, amtC]).toEqual([5000, 3000, 2000]); // 1회차=A, 2회차=B, 3회차=C (start_time 순)
  });

  it("다른 센터 매니저는 이 센터의 수업매출을 볼 권한이 없다", async () => {
    await asManagerB();
    await expect(fetchClassRevenueForDate(centerId, dateA)).rejects.toThrow();
    await expect(fetchClassRevenueDaily(centerId, dateA, dateA)).rejects.toThrow();
    await asManagerA();
  });
});

describe("수업매출: 정기권(기간제) usage_split / purchase_date_full 두 모드", () => {
  let productId: string;

  beforeAll(async () => {
    await asManagerA();
    productId = await createProduct("pass");
  });

  it("usage_split(기본): 결제총액 ÷ 실제 이용 횟수로 각 이용 날짜에 배분된다", async () => {
    const admin = getFixtureAdminClient();
    await admin.from("center_settings").upsert({ center_id: centerId, unlimited_pass_revenue_mode: "usage_split" }, { onConflict: "center_id" });

    const membershipId = await createMembership(userB.profileId, productId, { passType: "period" });
    await createPayment(userB.profileId, membershipId, 20000);
    const cls1 = await createFutureTestClass(centerId, { title: "CLASS-REV-PERIOD-1", hoursFromNow: 296 });
    const cls2 = await createFutureTestClass(centerId, { title: "CLASS-REV-PERIOD-2", hoursFromNow: 320 });
    await createReservation(cls1.id, userB.profileId, membershipId, "confirmed");
    await createReservation(cls2.id, userB.profileId, membershipId, "attended");

    const rows1 = await fetchClassRevenueForDate(centerId, kstDateStr(cls1.startTime));
    const rows2 = await fetchClassRevenueForDate(centerId, kstDateStr(cls2.startTime));
    const amt1 = rows1.filter((r) => r.type === "class").reduce((s, r) => s + r.amount, 0);
    const amt2 = rows2.filter((r) => r.type === "class").reduce((s, r) => s + r.amount, 0);
    expect(amt1).toBe(10000);
    expect(amt2).toBe(10000);
  });

  it("purchase_date_full: 결제총액 전액이 구매일에 표시되고 수업별로 안 나뉜다", async () => {
    const admin = getFixtureAdminClient();
    await admin.from("center_settings").upsert({ center_id: centerId, unlimited_pass_revenue_mode: "purchase_date_full" }, { onConflict: "center_id" });

    const membershipId = await createMembership(userB.profileId, productId, { passType: "period" });
    const paidAt = new Date(Date.now() + 400 * 3600 * 1000).toISOString();
    await createPayment(userB.profileId, membershipId, 15000, { paidAt });
    const cls = await createFutureTestClass(centerId, { title: "CLASS-REV-PERIOD-FULL", hoursFromNow: 400 });
    await createReservation(cls.id, userB.profileId, membershipId, "confirmed");

    const rows = await fetchClassRevenueForDate(centerId, kstDateStr(paidAt));
    const periodPassRow = rows.find((r) => r.type === "period_pass");
    expect(periodPassRow).toBeDefined();
    expect(periodPassRow!.amount).toBe(15000);
    // usage_split이었다면 붙었을 'class' 타입 행이 이 날짜엔 없어야 한다(수업별로 안 나뉘므로).
    expect(rows.filter((r) => r.type === "class")).toHaveLength(0);

    await admin.from("center_settings").upsert({ center_id: centerId, unlimited_pass_revenue_mode: "usage_split" }, { onConflict: "center_id" });
  });
});

describe("수업매출: 상품(goods) / 환불", () => {
  it("goods 상품 구매는 구매일에 '상품'으로 표시된다(수업과 무관)", async () => {
    await asManagerA();
    const goodsProductId = await createProduct("goods");
    const membershipId = await createMembership(userB.profileId, goodsProductId, { passType: "count", totalCount: 1 });
    const paidAt = new Date().toISOString();
    await createPayment(userB.profileId, membershipId, 5000, { paidAt });

    const rows = await fetchClassRevenueForDate(centerId, kstDateStr(paidAt));
    const goodsRow = rows.find((r) => r.type === "goods");
    expect(goodsRow).toBeDefined();
    expect(goodsRow!.amount).toBe(5000);
  });

  it("환불은 원 세션으로 소급 배분되지 않고 환불일에 음수로 표시된다", async () => {
    await asManagerA();
    const productId = await createProduct("pass");
    const membershipId = await createMembership(userB.profileId, productId, { passType: "count", totalCount: 1 });
    const paidAt = new Date().toISOString();
    await createPayment(userB.profileId, membershipId, -7000, { saleType: "refund", paidAt });

    const rows = await fetchClassRevenueForDate(centerId, kstDateStr(paidAt));
    const refundRow = rows.find((r) => r.type === "refund");
    expect(refundRow).toBeDefined();
    expect(refundRow!.amount).toBe(-7000);
  });
});
