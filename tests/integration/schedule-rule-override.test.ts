/*
  P1 신규 정책: "관리자가 수업에서 직접 지정한 수강권(class_allowed_products)은
  membership_schedule_rules보다 우선한다" — RPC/DB 레벨 회귀 테스트(A~J).

  fix_membership_schedule_rule_override_draft_proposed.sql이 아직 Supabase에 적용되지
  않았다면 D/E/J(override가 실제로 통과해야 하는 케이스)는 실패한다(예상된 실패 — 최종
  보고서 "SQL 필요 여부"에 기록). C/F/G/H(여전히 차단돼야 하는 케이스)는 SQL 적용 여부와
  무관하게 항상 통과해야 한다.

  [2026-08-11 수강권 허용 정책 변경, add_class_trainers_pass_selection_mode_draft_proposed.sql]
  위 override 로직(usable_memberships_for_classes/reserve_class/reserve_with_membership)이
  "class_allowed_products 행 존재 여부" 대신 classes.pass_selection_mode('all'|'selected')를
  신뢰하도록 다시 바뀌었다. D~J는 "특정 수강권 직접 지정" 시나리오이므로 class_allowed_products에
  넣는 것과 별개로 반드시 passSelectionMode: "selected"를 함께 지정해야 한다 — 그러지 않으면
  mode 기본값('all')이 cap 목록과 무관하게 전부 허용해버려, override/차단을 검증하려던 이
  테스트들이 실제로는 아무것도 증명하지 못한 채 우연히 통과(또는 새로 실패)할 수 있다. 이
  SQL도 아직 적용되지 않았다면 D/E/E-보조/J는 (pass_selection_mode 컬럼이 없어) 실패한다.

  실제 사용 경로 검증을 위해 순수 함수를 재구현하지 않고, 실제 RPC
  (reserve_class/reserve_with_membership/usable_memberships_for_classes)를 그대로 호출한다
  (class-allowed-products-enforcement.test.ts/private-class-capacity.test.ts와 동일 관례).

  케이스 매핑:
    A: schedule rule 없음 + 모든 수강권 허용 → 사용 가능
    B: schedule rule 있음 + 모든 수강권 허용 + rule 일치 → 사용 가능
    C: schedule rule 있음 + 모든 수강권 허용 + rule 불일치 → 사용 불가
    D: schedule rule 있음 + 특정 수강권 직접 지정 + rule 일치 → 사용 가능
    E: schedule rule 있음 + 특정 수강권 직접 지정 + rule 불일치 → 사용 가능(★ 신규 override 핵심)
    F: schedule rule 불일치 + 다른 product만 class_allowed_products에 지정 → 이 membership은 여전히 사용 불가
    G: 특정 수강권 직접 지정 + membership 만료 → 사용 불가
    H: 특정 수강권 직접 지정 + remaining_count=0 → 사용 불가
    I: 특정 수강권 직접 지정 + goods 상품 → pass처럼 사용할 수 없음
    J: 새로 구매한(재발급) membership + 해당 product가 수업에 직접 지정됨 + rule 불일치 → 새 membership도 사용 가능
  K(관리자 UI 문구/판정 차이 안내)는 실제 화면 렌더링이 필요해 E2E에서 별도 검증한다
  (tests/e2e/admin/membership-schedule-rules.spec.ts).
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  signOutTestSession,
  type TestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  getFixtureAdminClient,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MEMBER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

let managerA: TestUser;
let memberA: TestUser;
let centerAId: string;
let passA: { id: string };   // 이번 테스트의 "주 대상" 수강권(schedule_rules를 걸었다 지웠다 함)
let passB: { id: string };   // F 케이스용 "다른" 수강권
let goodsZ: { id: string };  // I 케이스용

const cleanupClassIds: string[] = [];

async function asManagerA() { await switchToTestUser(MANAGER_A.email, MANAGER_A.password); }
async function asMemberA() { await switchToTestUser(MEMBER_A.email, MEMBER_A.password); }

async function createNamedPassProduct(centerId: string, name: string, kind: "pass" | "goods" = "pass"): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const { data: existing } = await admin.from("products").select("id").eq("center_id", centerId).eq("name", name).eq("product_kind", kind).maybeSingle();
  if (existing) return { id: existing.id };
  const { data, error } = await admin
    .from("products")
    .insert({ center_id: centerId, name, product_kind: kind, pass_type: "count", total_count: 999, is_on_sale: true, is_active: true })
    .select("id").single();
  if (error || !data) throw new Error(`상품(${name}) 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id };
}

// get-or-create + 매 호출마다 opts로 상태를 덮어씀(공유 테스트센터 오염 방지 관례,
// class-allowed-products-enforcement.test.ts의 createMembershipForProduct와 동일 패턴).
async function createMembershipForProduct(
  centerId: string, profileId: string, productId: string,
  opts?: { remainingCount?: number; expired?: boolean }
): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const remaining = opts?.remainingCount ?? 5;
  const expired = opts?.expired ?? false;
  const expiresAt = expired
    ? new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    : new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const { data: existing, error: findErr } = await admin
    .from("memberships")
    .select("id")
    .eq("profile_id", profileId)
    .eq("center_id", centerId)
    .eq("product_id", productId)
    .limit(1);
  if (findErr) throw new Error(`수강권 조회 실패: ${findErr.message}`);
  if (existing && existing.length > 0) {
    const { error: refreshErr } = await admin
      .from("memberships")
      .update({
        total_count: remaining, remaining_count: expired ? 0 : remaining,
        expires_at: expiresAt, status: expired ? "expired" : "active",
      })
      .eq("id", existing[0].id);
    if (refreshErr) throw new Error(`수강권 갱신 실패: ${refreshErr.message}`);
    return { id: existing[0].id };
  }

  const { data, error } = await admin
    .from("memberships")
    .insert({
      profile_id: profileId, center_id: centerId, product_id: productId,
      product_name: "통합테스트 수강권(P1 override)", pass_type: "count",
      total_count: remaining, remaining_count: expired ? 0 : remaining,
      expires_at: expiresAt, status: expired ? "expired" : "active",
    })
    .select("id").single();
  if (error || !data) throw new Error(`수강권 생성 실패: ${error.message}`);
  return { id: data.id };
}

async function clearScheduleRules(productId: string): Promise<void> {
  const admin = getFixtureAdminClient();
  const { error } = await admin.from("membership_schedule_rules").delete().eq("product_id", productId);
  if (error) throw new Error(`schedule_rules 삭제 실패: ${error.message}`);
}

async function setScheduleRule(
  productId: string,
  rule: { dayOfWeek: number | null; startTime: string | null; classTitle: string | null }
): Promise<void> {
  const admin = getFixtureAdminClient();
  const { error } = await admin.from("membership_schedule_rules").insert({
    product_id: productId, day_of_week: rule.dayOfWeek, start_time: rule.startTime, class_title: rule.classTitle,
  });
  if (error) throw new Error(`schedule_rule 추가 실패: ${error.message}`);
}

// 클래스 start_time의 초/밀리초를 0으로 정규화 — schedule_rules.start_time(초 단위까지
// 저장되는 time 컬럼)과 정확히 일치시키기 위함(membership-schedule-rules.spec.ts의 "사고
// 기록"과 동일한 이유: createFutureTestClass의 start_time은 Date.now() 기반이라 초/밀리초가
// 0이 아님).
async function normalizeClassStartTime(classId: string, startTimeIso: string): Promise<string> {
  const d = new Date(startTimeIso);
  d.setUTCSeconds(0, 0);
  const cleanIso = d.toISOString();
  const admin = getFixtureAdminClient();
  const { error } = await admin.from("classes").update({ start_time: cleanIso }).eq("id", classId);
  if (error) throw new Error(`class start_time 정규화 실패: ${error.message}`);
  return cleanIso;
}

function kstDowFromIso(iso: string): number {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.getUTCDay();
}
function kstTimeStrFromIso(iso: string): string {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}:${String(kst.getUTCSeconds()).padStart(2, "0")}`;
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  memberA = await switchToTestUser(MEMBER_A.email, MEMBER_A.password);

  await asManagerA();
  passA = await createNamedPassProduct(centerAId, "P1 override 통합-패스A");
  passB = await createNamedPassProduct(centerAId, "P1 override 통합-패스B");
  goodsZ = await createNamedPassProduct(centerAId, "P1 override 통합-굿즈Z", "goods");
}, 30000);

afterAll(async () => {
  await asManagerA();
  for (const id of cleanupClassIds) {
    await supabase.from("reservations").delete().eq("class_id", id);
    await supabase.from("classes").delete().eq("id", id);
  }
  await clearScheduleRules(passA.id);
  await clearScheduleRules(passB.id);
  await signOutTestSession();
}, 30000);

beforeEach(async () => {
  await asManagerA();
  await clearScheduleRules(passA.id);
  await clearScheduleRules(passB.id);
});

describe("A~C: '모든 수강권 허용' — schedule_rules는 override와 무관하게 그대로 적용", () => {
  it("A: schedule rule 없음 + 모든 수강권 허용 → 사용 가능", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-A", hoursFromNow: 500 });
    cleanupClassIds.push(cls.id);
    const mem = await createMembershipForProduct(centerAId, memberA.profileId, passA.id);

    await asMemberA();
    const list = await supabase.rpc("usable_memberships_for_classes", { p_class_ids: [cls.id], p_profile_id: memberA.profileId });
    expect(list.error).toBeNull();
    expect((list.data ?? []).some((r: any) => r.membership_id === mem.id)).toBe(true);

    // ⚠ reserve_class(자동 매칭)는 어떤 membership을 쓸지 지정할 수 없다 — centerA는 공유
    // 테스트센터라 memberA가 passA 말고 다른 유효한 membership을 이미 보유하고 있으면
    // reserve_class가 그걸 대신 골라도 이 assert(성공)는 똑같이 통과해버려, 정작 passA가
    // 실제로 사용됐는지는 증명하지 못한다(C에서 이 모호함이 실제 실패로 드러남).
    // reserve_with_membership으로 mem.id를 직접 지정해 passA가 쓰였음을 결정적으로 확인한다.
    const res = await supabase.rpc("reserve_with_membership", {
      p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: mem.id,
    });
    expect(res.error).toBeNull();
    expect(res.data.status).toBe("confirmed");
  });

  it("B: schedule rule 있음 + 모든 수강권 허용 + rule 일치 → 사용 가능", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-B", hoursFromNow: 501 });
    cleanupClassIds.push(cls.id);
    const cleanStart = await normalizeClassStartTime(cls.id, cls.startTime);
    const dow = kstDowFromIso(cleanStart);
    const timeStr = kstTimeStrFromIso(cleanStart);
    await setScheduleRule(passA.id, { dayOfWeek: dow, startTime: timeStr, classTitle: "P1override-B" });
    const mem = await createMembershipForProduct(centerAId, memberA.profileId, passA.id);

    await asMemberA();
    const res = await supabase.rpc("reserve_with_membership", {
      p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: mem.id,
    });
    expect(res.error).toBeNull();
    expect(res.data.status).toBe("confirmed");
  });

  it("C: schedule rule 있음 + 모든 수강권 허용 + rule 불일치 → 사용 불가", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-C", hoursFromNow: 502 });
    cleanupClassIds.push(cls.id);
    const dow = kstDowFromIso(cls.startTime);
    const mismatchedDow = (dow + 1) % 7;
    await setScheduleRule(passA.id, { dayOfWeek: mismatchedDow, startTime: null, classTitle: null });
    const mem = await createMembershipForProduct(centerAId, memberA.profileId, passA.id);

    await asMemberA();
    // ⚠ reserve_class(자동 매칭)는 어떤 membership을 쓸지 지정할 수 없다 — centerA는 이
    // 스위트의 여러 파일이 공유하는 테스트센터라 memberA가 passA 말고도 다른(제한 없는)
    // 유효한 membership을 이미 보유하고 있을 수 있고, 그러면 reserve_class가 그 다른
    // membership으로 조용히 성공해버려 이 테스트가 실제로 검증하려는 것(passA의 schedule
    // rule 불일치 차단)과 무관하게 통과해버린다(실측: CI에서 정확히 이렇게 재현됨,
    // res.error가 null이었음 — 앱/SQL 버그 아니라 이 테스트의 RPC 선택이 잘못됐던 것).
    // reserve_with_membership으로 passA의 membership_id를 직접 지정해 결정적으로 검증한다.
    const res = await supabase.rpc("reserve_with_membership", {
      p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: mem.id,
    });
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toContain("사용할 수 없는 수강권");

    const { data: rows } = await supabase.from("reservations").select("id").eq("class_id", cls.id);
    expect((rows ?? []).length).toBe(0);
  });
});

describe("D~F: '특정 수강권 직접 지정' — schedule_rules override(신규 정책)", () => {
  it("D: schedule rule 있음 + 특정 수강권 직접 지정 + rule 일치 → 사용 가능", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-D", hoursFromNow: 503, passSelectionMode: "selected" });
    cleanupClassIds.push(cls.id);
    const cleanStart = await normalizeClassStartTime(cls.id, cls.startTime);
    const dow = kstDowFromIso(cleanStart);
    const timeStr = kstTimeStrFromIso(cleanStart);
    await setScheduleRule(passA.id, { dayOfWeek: dow, startTime: timeStr, classTitle: "P1override-D" });
    const { error: linkErr } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: passA.id });
    expect(linkErr).toBeNull();
    const mem = await createMembershipForProduct(centerAId, memberA.profileId, passA.id);

    await asMemberA();
    const res = await supabase.rpc("reserve_with_membership", { p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: mem.id });
    expect(res.error).toBeNull();
    expect(res.data.status).toBe("confirmed");
  });

  it("E(★핵심): schedule rule 있음 + 특정 수강권 직접 지정 + rule 불일치 → 사용 가능(override)", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-E", hoursFromNow: 504, passSelectionMode: "selected" });
    cleanupClassIds.push(cls.id);
    const dow = kstDowFromIso(cls.startTime);
    const mismatchedDow = (dow + 1) % 7;
    await setScheduleRule(passA.id, { dayOfWeek: mismatchedDow, startTime: null, classTitle: null });
    const { error: linkErr } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: passA.id });
    expect(linkErr).toBeNull();
    const mem = await createMembershipForProduct(centerAId, memberA.profileId, passA.id);

    await asMemberA();
    // 목록 표시 정책도 override를 반영해야 함(목록≠실제 RPC 불일치가 없어야 함).
    const list = await supabase.rpc("usable_memberships_for_classes", { p_class_ids: [cls.id], p_profile_id: memberA.profileId });
    expect(list.error).toBeNull();
    expect((list.data ?? []).some((r: any) => r.membership_id === mem.id)).toBe(true);

    const res = await supabase.rpc("reserve_with_membership", { p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: mem.id });
    expect(res.error).toBeNull();
    expect(res.data.status).toBe("confirmed");
  });

  it("E-보조: 같은 override 조건에서 reserve_class(자동 매칭)도 통과한다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-E2", hoursFromNow: 505, passSelectionMode: "selected" });
    cleanupClassIds.push(cls.id);
    const dow = kstDowFromIso(cls.startTime);
    const mismatchedDow = (dow + 1) % 7;
    await setScheduleRule(passA.id, { dayOfWeek: mismatchedDow, startTime: null, classTitle: null });
    const { error: linkErr } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: passA.id });
    expect(linkErr).toBeNull();
    await createMembershipForProduct(centerAId, memberA.profileId, passA.id);

    await asMemberA();
    const res = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: memberA.profileId });
    expect(res.error).toBeNull();
    expect(res.data.status).toBe("confirmed");
  });

  it("F: schedule rule 불일치 + 다른 product(B)만 class_allowed_products에 지정 → passA는 여전히 사용 불가(override가 새지 않음)", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-F", hoursFromNow: 506, passSelectionMode: "selected" });
    cleanupClassIds.push(cls.id);
    // passA는 schedule_rules가 아예 없는 상태(clearScheduleRules는 beforeEach가 이미 처리) —
    // schedule_rules가 원인이 아니라 순수히 class_allowed_products(cap)만으로 차단되는지 확인.
    const { error: linkErr } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: passB.id });
    expect(linkErr).toBeNull();
    const memA = await createMembershipForProduct(centerAId, memberA.profileId, passA.id);

    await asMemberA();
    const res = await supabase.rpc("reserve_with_membership", { p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: memA.id });
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toContain("사용할 수 없는 수강권");

    const { data: rows } = await supabase.from("reservations").select("id").eq("class_id", cls.id);
    expect((rows ?? []).length).toBe(0);
  });
});

describe("G~I: override는 schedule_rules만 우회함 — 다른 정상 조건은 그대로 차단", () => {
  it("G: 특정 수강권 직접 지정 + membership 만료 → 사용 불가", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-G", hoursFromNow: 507, passSelectionMode: "selected" });
    cleanupClassIds.push(cls.id);
    const dow = kstDowFromIso(cls.startTime);
    const mismatchedDow = (dow + 1) % 7;
    await setScheduleRule(passA.id, { dayOfWeek: mismatchedDow, startTime: null, classTitle: null });
    const { error: linkErr } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: passA.id });
    expect(linkErr).toBeNull();
    const mem = await createMembershipForProduct(centerAId, memberA.profileId, passA.id, { expired: true });

    await asMemberA();
    const res = await supabase.rpc("reserve_with_membership", { p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: mem.id });
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toContain("사용할 수 없는 수강권");

    // 정상 상태로 복구(다음 테스트/재실행 오염 방지)
    await asManagerA();
    await createMembershipForProduct(centerAId, memberA.profileId, passA.id);
  });

  it("H: 특정 수강권 직접 지정 + remaining_count=0 → 사용 불가", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-H", hoursFromNow: 508, passSelectionMode: "selected" });
    cleanupClassIds.push(cls.id);
    const dow = kstDowFromIso(cls.startTime);
    const mismatchedDow = (dow + 1) % 7;
    await setScheduleRule(passA.id, { dayOfWeek: mismatchedDow, startTime: null, classTitle: null });
    const { error: linkErr } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: passA.id });
    expect(linkErr).toBeNull();
    const mem = await createMembershipForProduct(centerAId, memberA.profileId, passA.id, { remainingCount: 0 });

    await asMemberA();
    const res = await supabase.rpc("reserve_with_membership", { p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: mem.id });
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toContain("사용할 수 없는 수강권");

    await asManagerA();
    await createMembershipForProduct(centerAId, memberA.profileId, passA.id);
  });

  it("I: goods 상품은 class_allowed_products에 애초에 연결할 수 없다(RLS) — override 대상 자체가 될 수 없음", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-I", hoursFromNow: 509 });
    cleanupClassIds.push(cls.id);
    // class-allowed-products-enforcement.test.ts에서 이미 "goods 상품을 연결하려 하면 RLS가
    // 거부한다"를 검증했다 — 여기서는 그 전제가 이번 P1 override 시나리오에서도 그대로
    // 유지되는지만 재확인한다(회귀 확인 목적, 새 RLS 아님).
    const { error: linkErr } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: goodsZ.id });
    expect(linkErr).not.toBeNull();
  });
});

describe("J: 새로 구매(재발급)한 membership도 동일한 override를 받는다", () => {
  it("J: 기존 membership을 지우고 새로 발급해도, 같은 product면 override가 그대로 적용된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "P1override-J", hoursFromNow: 510, passSelectionMode: "selected" });
    cleanupClassIds.push(cls.id);
    const dow = kstDowFromIso(cls.startTime);
    const mismatchedDow = (dow + 1) % 7;
    await setScheduleRule(passA.id, { dayOfWeek: mismatchedDow, startTime: null, classTitle: null });
    const { error: linkErr } = await supabase.from("class_allowed_products").insert({ class_id: cls.id, product_id: passA.id });
    expect(linkErr).toBeNull();

    const admin = getFixtureAdminClient();
    await admin.from("memberships").delete().eq("profile_id", memberA.profileId).eq("product_id", passA.id);
    const { data: newMem, error: newMemErr } = await admin.from("memberships").insert({
      profile_id: memberA.profileId, center_id: centerAId, product_id: passA.id,
      product_name: "통합테스트 수강권(P1 override, 재발급)", pass_type: "count",
      total_count: 5, remaining_count: 5,
      expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10), status: "active",
    }).select("id").single();
    if (newMemErr || !newMem) throw new Error(`신규 membership 생성 실패: ${newMemErr?.message ?? "no data"}`);

    await asMemberA();
    const res = await supabase.rpc("reserve_with_membership", { p_class_id: cls.id, p_profile_id: memberA.profileId, p_membership_id: newMem.id });
    expect(res.error).toBeNull();
    expect(res.data.status).toBe("confirmed");

    // 다음 테스트/재실행 오염 방지 — 표준 fixture 상태로 복구
    await asManagerA();
    await createMembershipForProduct(centerAId, memberA.profileId, passA.id);
  });
});
