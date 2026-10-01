/*
  QA 시나리오 4 — 관리자 수강권 만료일 연장(add_membership_expiry_extension.sql 적용 후).
  - 실행: npm run qa:production:membership-expiry (QA_TARGET_PROJECT_REF / QA_PRODUCTION_ACK=1 필요). TEST_MANAGER_B_*가 있어야 직원 권한 검증이 실행된다.
  - QA owner(TEST_MANAGER_A)는 전용 권한 없이도 오너라 연장 가능. QA 직원(TEST_MANAGER_B)은 이번 실행 전용 역할로 pass_detail/issue_pass만 가진다.
  - 앱 경로: lib/members.ts extendMembershipExpiry → RPC manager_extend_membership_expiry. 직접 UPDATE 우회는 supabase.from("memberships").update로 시도한다.
  - QA 센터 안에서만, 이번 실행이 만든 UUID로만 정리한다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extendMembershipExpiry } from "../../../lib/members";
import { addDaysToYmd, todayKstYmd } from "../../../lib/membershipExpiry";
import { supabase } from "../../../lib/supabaseClient";
import { getFixtureAdminClient, signOutTestSession, switchToTestUser } from "../../integration/setup";
import { bootstrapQa } from "../fixtures/bootstrap";
import { createQaGoodsMembership } from "../fixtures/catalog";
import { createQaStaff } from "../fixtures/staff";
import { cleanupFixtures, createRunId, FixtureTracker, qaName, shouldKeepFailedFixtures } from "../runContext";
import type { QaFixtureState } from "../fixtures/center";

const admin = () => getFixtureAdminClient();
const tracker = new FixtureTracker(createRunId());
const hasStaff = !!(process.env.TEST_MANAGER_B_EMAIL && process.env.TEST_MANAGER_B_PASSWORD);
let state: QaFixtureState;
let membershipId = "";
let goodsMembershipId = "";
let unlimitedId = "";
let startExpires = "";
let failed = false;
let snapshot: Record<string, unknown> = {};

async function row(id: string) {
  const { data, error } = await admin().from("memberships")
    .select("id, expires_at, remaining_count, total_count, starts_at, status, product_id, profile_id, center_id").eq("id", id).single();
  if (error) throw new Error(`수강권 조회 실패: ${error.message}`);
  return data as any;
}
const withoutExpiry = (r: any) => { const { expires_at, ...rest } = r; return rest; };

async function asOwner() { await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD"); }

describe("QA: 수강권 만료일 연장", () => {
  beforeAll(async () => {
    ({ state } = await bootstrapQa());
    const today = todayKstYmd();
    startExpires = addDaysToYmd(today, 30);
    const mem = await admin().from("memberships").insert({
      profile_id: state.memberProfileId, center_id: state.centerId, product_name: qaName(tracker.runId, "연장 테스트 수강권"), pass_type: "count",
      total_count: 10, remaining_count: 7, starts_at: today, expires_at: startExpires, status: "active",
    }).select("id").single();
    if (mem.error || !mem.data) throw new Error(`QA 수강권 생성 실패: ${mem.error?.message}`);
    membershipId = mem.data.id as string;
    tracker.add("memberships", membershipId);
    // 무제한(expires_at null) 수강권
    const unl = await admin().from("memberships").insert({
      profile_id: state.memberProfileId, center_id: state.centerId, product_name: qaName(tracker.runId, "무제한 수강권"), pass_type: "count",
      total_count: 5, remaining_count: 5, starts_at: today, expires_at: null, status: "active",
    }).select("id").single();
    if (unl.error || !unl.data) throw new Error(`QA 무제한 수강권 생성 실패: ${unl.error?.message}`);
    unlimitedId = unl.data.id as string;
    tracker.add("memberships", unlimitedId);
    ({ membershipId: goodsMembershipId } = await createQaGoodsMembership(admin(), tracker, state.centerId, state.memberProfileId, { count: 4, size: "240" }));
    snapshot = withoutExpiry(await row(membershipId));
  });

  afterAll(async () => {
    const keep = shouldKeepFailedFixtures(process.env, failed);
    // 이번 실행이 남긴 감사 로그(수강권 FK)를 먼저 추적해 정리 대상에 올린다
    const logs = await admin().from("admin_action_logs").select("id").in("membership_id", [membershipId, goodsMembershipId, unlimitedId].filter(Boolean));
    for (const l of logs.data ?? []) tracker.add("admin_action_logs", (l as any).id);
    const res = await cleanupFixtures(admin(), tracker, { keep });
    if (keep) console.warn(`[QA] QA_KEEP_FAILED_FIXTURES=1 — 실패한 fixture를 보존했어요(runId ${tracker.runId}, ${tracker.total()}개)`);
    if (res.failures.length > 0) console.warn(`[QA] 정리 중 일부 실패: ${res.failures.join(" | ")}`);
    await signOutTestSession();
  });

  const step = (name: string, fn: () => Promise<void>) => it(name, async () => {
    try { await fn(); } catch (e) { failed = true; throw e; }
  });

  step("1~2. QA owner가 +7일 연장 → 정확히 +7일, 다른 필드(잔여/총횟수/시작일/상태)는 그대로", async () => {
    await asOwner();
    const r = await extendMembershipExpiry({ membershipId, mode: "days", days: 7, reason: `[QA ${tracker.runId}] +7일` });
    const expected = addDaysToYmd(startExpires, 7);
    expect(r).toMatchObject({ oldExpiresAt: startExpires, newExpiresAt: expected, daysAdded: 7 });
    const after = await row(membershipId);
    expect(after.expires_at).toBe(expected);
    expect(withoutExpiry(after)).toEqual(snapshot);
  });

  step("3~4. 날짜 지정으로 더 뒤 날짜로 연장 → 정확히 그 날짜", async () => {
    const target = addDaysToYmd(startExpires, 40);
    const r = await extendMembershipExpiry({ membershipId, mode: "date", newExpiresAt: target });
    expect(r.newExpiresAt).toBe(target);
    expect((await row(membershipId)).expires_at).toBe(target);
  });

  step("단축/같은 날짜/0일/음수/과거 날짜는 서버가 거부하고 만료일이 바뀌지 않는다", async () => {
    const cur = (await row(membershipId)).expires_at as string;
    await expect(extendMembershipExpiry({ membershipId, mode: "date", newExpiresAt: addDaysToYmd(cur, -1) })).rejects.toThrow(/뒤여야/);
    await expect(extendMembershipExpiry({ membershipId, mode: "date", newExpiresAt: cur })).rejects.toThrow(/뒤여야/);
    await expect(extendMembershipExpiry({ membershipId, mode: "days", days: 0 })).rejects.toThrow(/1일 이상/);
    await expect(extendMembershipExpiry({ membershipId, mode: "days", days: -3 })).rejects.toThrow();
    expect((await row(membershipId)).expires_at).toBe(cur);
  });

  step("owner도 memberships.expires_at 직접 UPDATE는 가드 트리거가 거부(전용 RPC만 허용)", async () => {
    const cur = (await row(membershipId)).expires_at as string;
    const { error } = await supabase.from("memberships").update({ expires_at: addDaysToYmd(cur, 5) }).eq("id", membershipId);
    expect(error).not.toBeNull();
    expect((await row(membershipId)).expires_at).toBe(cur);
  });

  step("goods 수강권과 무제한 수강권은 연장할 수 없다", async () => {
    await expect(extendMembershipExpiry({ membershipId: goodsMembershipId, mode: "days", days: 7 })).rejects.toThrow(/대여상품/);
    await expect(extendMembershipExpiry({ membershipId: unlimitedId, mode: "days", days: 7 })).rejects.toThrow(/무제한/);
    expect((await row(unlimitedId)).expires_at).toBeNull();
  });

  step("10. 감사 로그(admin_action_logs MEMBERSHIP_UPDATE/EXPIRY_EXTEND): 이전/새 만료일, 방식, 일수, 사유, 변경한 관리자", async () => {
    const { data, error } = await admin().from("admin_action_logs")
      .select("center_id, admin_id, member_profile_id, membership_id, action_type, reason_code, reason_detail, before_state, after_state, created_at")
      .eq("membership_id", membershipId).eq("reason_code", "EXPIRY_EXTEND").order("created_at", { ascending: true });
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    const [first, second] = data as any[];
    expect(first).toMatchObject({ center_id: state.centerId, member_profile_id: state.memberProfileId, action_type: "MEMBERSHIP_UPDATE", admin_id: state.managerAccountId });
    expect(first.before_state.expires_at).toBe(startExpires);
    expect(first.after_state).toMatchObject({ expires_at: addDaysToYmd(startExpires, 7), mode: "days", days: 7 });
    expect(first.reason_detail).toContain(tracker.runId);
    expect(second.after_state).toMatchObject({ mode: "date", expires_at: addDaysToYmd(startExpires, 40) });
    expect(first.created_at).toBeTruthy();
  });

  (hasStaff ? step : (name: string) => it.skip(name, async () => {}))("8~9. 새 권한이 없는 직원(pass_detail/issue_pass만): RPC 거부 + 직접 UPDATE 우회 거부, 다른 컬럼 UPDATE는 기존대로 허용", async () => {
    await createQaStaff(admin(), tracker, {
      centerId: state.centerId,
      staffAccountId: (await switchToTestUser("TEST_MANAGER_B_EMAIL", "TEST_MANAGER_B_PASSWORD")).accountId,
      permissionKeys: ["customer.member.view", "customer.member.pass_detail", "customer.member.issue_pass"],
    });
    const cur = (await row(membershipId)).expires_at as string;
    await expect(extendMembershipExpiry({ membershipId, mode: "days", days: 7 })).rejects.toThrow(/권한/);
    const direct = await supabase.from("memberships").update({ expires_at: addDaysToYmd(cur, 9) }).eq("id", membershipId);
    expect(direct.error).not.toBeNull();   // RLS는 통과해도(pass_detail) expires_at 가드가 거부
    expect((await row(membershipId)).expires_at).toBe(cur);
    // 기존 정상 UPDATE(만료일을 건드리지 않는 수정)는 막히지 않는다
    const cnt = (await row(membershipId)).remaining_count;
    const ok = await supabase.from("memberships").update({ remaining_count: cnt }).eq("id", membershipId);
    expect(ok.error).toBeNull();
  });

  step("회원(권한 없는 일반 사용자)도 RPC가 거부한다", async () => {
    await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
    await expect(extendMembershipExpiry({ membershipId, mode: "days", days: 7 })).rejects.toThrow(/권한/);
  });

  step("11. 연장 전후로 잔여 횟수 등 다른 필드가 변하지 않았다", async () => {
    expect(withoutExpiry(await row(membershipId))).toEqual(snapshot);
  });
});
