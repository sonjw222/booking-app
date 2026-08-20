/*
  SEC-009 RLS Gap Batch A2 회귀 테스트 (contracts, notification_logs).

  ⚠ 이 파일은 fix_rls_gap_batch_a2_contracts_notification_logs_draft_proposed.sql이
  실제로 Supabase에 적용되기 전에는 의도적으로 FAIL해야 한다(두 테이블 전부 정책 0건 →
  오너를 포함해 아무도 접근 불가, fixture 준비 단계에서부터 막힘). 적용 후 실행하면 이
  파일이 green이어야 정상이다.

  docs/22_RLS_Gap_A2_Investigation.md의 "테스트 설계" 절을 그대로 구현한다. Batch A1
  (staff_salaries/leads/messages, tests/integration/sec009-batch-a1-rls.test.ts)과 파일을
  분리한 이유는 그 파일 헤더 주석과 동일 — 원인 분리를 위해서다.

  두 테이블 모두 클라이언트 INSERT 정책이 의도적으로 없다(계약서 발급은 향후 RPC로,
  알림 로그는 서버 트리거 전용으로 설계) — fixture는 admin(service_role) client로만
  만들고 지운다. service_role GRANT는 2026-08-18 read-only로 이미 Live에 있음을 확인함.

  Fixture: TEST_MANAGER_A(centerA 오너)/TEST_MANAGER_B(centerB 오너, centerA에는 권한 0개
  스태프로 초대)/TEST_USER_A(계약서 본인 소유자 역할) 세 계정만 재사용한다(ACL-003/
  SEC-009 Batch A1과 동일 패턴 — 새 GitHub Secrets 없음).
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, getFixtureAdminClient, type TestUser } from "./setup";
import { createRole, fetchRoles, inviteStaff, removeStaff, deleteRole, setStaffOverride } from "../../lib/roles";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const USER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

const NO_PERM_ROLE_NAME = "SEC-009 Batch A2 테스트 무권한 역할";

let managerA: TestUser;
let managerB: TestUser;
let userA: TestUser;
let centerAId: string;
let staffManagerCenterId: string; // centerA에서 managerB(비오너 스태프)의 manager_centers.id

let contractId: string | null = null;
let notifSmsId: string | null = null;
let notifPushId: string | null = null;

async function cleanupNoPermRoleAndInvite(centerId: string): Promise<void> {
  const roles = await fetchRoles(centerId);
  const stale = roles.filter((r) => r.name === NO_PERM_ROLE_NAME);
  for (const role of stale) {
    const { data: staleInvites } = await supabase
      .from("manager_centers")
      .select("id")
      .eq("center_id", centerId)
      .eq("role_id", role.id);
    for (const inv of staleInvites ?? []) {
      try { await removeStaff((inv as { id: string }).id); } catch { /* best-effort */ }
    }
    try { await deleteRole(role.id); } catch { /* best-effort — 다음 실행이 다시 시도함 */ }
  }
}

async function managerCenterIdFor(centerId: string, accountId: string): Promise<string> {
  const { data, error } = await supabase
    .from("manager_centers")
    .select("id")
    .eq("center_id", centerId)
    .eq("account_id", accountId)
    .single();
  if (error || !data) throw new Error("manager_centers 행을 찾지 못했어요: " + error?.message);
  return (data as { id: string }).id;
}

const BATCH_A2_KEYS = ["contract.list.view", "message.sms.view", "message.push.view"];
async function clearManagerBOverrides() {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  for (const key of BATCH_A2_KEYS) {
    await setStaffOverride(staffManagerCenterId, key, null);
  }
}
afterEach(async () => {
  await clearManagerBOverrides();
});

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  await getOrCreateOwnedTestCenter(managerB); // centerB — "타 센터 오너" 페르소나용

  userA = await switchToTestUser(USER_A.email, USER_A.password);

  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  await cleanupNoPermRoleAndInvite(centerAId);

  await createRole(centerAId, NO_PERM_ROLE_NAME);
  const roles = await fetchRoles(centerAId);
  const role = roles.find((r) => r.name === NO_PERM_ROLE_NAME);
  if (!role) throw new Error("무권한 역할 생성에 실패했어요");

  await inviteStaff(centerAId, managerB.accountId, role.id);
  staffManagerCenterId = await managerCenterIdFor(centerAId, managerB.accountId);

  // contracts/notification_logs는 클라이언트 INSERT 정책이 없으므로 admin client로만 만든다.
  const admin = getFixtureAdminClient();

  const { data: contractRow, error: contractErr } = await admin
    .from("contracts")
    .insert({
      center_id: centerAId,
      profile_id: userA.profileId,
      content: "SEC-009 Batch A2 테스트 계약서 본문",
      status: "signed",
    })
    .select("id").single();
  if (contractErr) throw new Error("contracts fixture 생성 실패: " + contractErr.message);
  contractId = (contractRow as { id: string }).id;

  const { data: notifSmsRow, error: notifSmsErr } = await admin
    .from("notification_logs")
    .insert({ center_id: centerAId, profile_id: userA.profileId, channel: "sms", cost: 20, status: "sent" })
    .select("id").single();
  if (notifSmsErr) throw new Error("notification_logs(sms) fixture 생성 실패: " + notifSmsErr.message);
  notifSmsId = (notifSmsRow as { id: string }).id;

  const { data: notifPushRow, error: notifPushErr } = await admin
    .from("notification_logs")
    .insert({ center_id: centerAId, profile_id: userA.profileId, channel: "push", cost: 0, status: "sent" })
    .select("id").single();
  if (notifPushErr) throw new Error("notification_logs(push) fixture 생성 실패: " + notifPushErr.message);
  notifPushId = (notifPushRow as { id: string }).id;
}, 30000);

afterAll(async () => {
  const admin = getFixtureAdminClient();
  const errors: string[] = [];

  const deleteRow = async (table: string, id: string | null, label: string) => {
    if (!id) return;
    const { error } = await admin.from(table).delete().eq("id", id);
    if (error) errors.push(`${label} 정리 실패(id=${id}): ${error.message}`);
  };
  await deleteRow("contracts", contractId, "contracts");
  await deleteRow("notification_logs", notifSmsId, "notification_logs(sms)");
  await deleteRow("notification_logs", notifPushId, "notification_logs(push)");

  try {
    await clearManagerBOverrides();
  } catch (e: any) {
    errors.push(`권한 오버라이드 정리 실패: ${e.message}`);
  }

  try {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await cleanupNoPermRoleAndInvite(centerAId);
  } catch (e: any) {
    errors.push(`무권한 역할/초대 정리 실패: ${e.message}`);
  }

  if (errors.length > 0) {
    throw new Error(`SEC-009 Batch A2 fixture cleanup 실패 — 공유 개발 DB에 잔여 데이터가 남았을 수 있습니다:\n${errors.join("\n")}`);
  }
}, 30000);

describe("contracts — SELECT만 정책, 본인/권한 보유 스태프만 조회", () => {
  it("무권한 스태프(managerB)는 다른 사람의 계약서를 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("contracts").select("id").eq("id", contractId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("본인(userA, 계약서의 profile 소유자)은 자기 계약서를 조회할 수 있다", async () => {
    await switchToTestUser(USER_A.email, USER_A.password);
    const { data, error } = await supabase.from("contracts").select("id").eq("id", contractId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("contract.list.view 권한이 있으면 다른 사람의 계약서도 조회할 수 있다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await setStaffOverride(staffManagerCenterId, "contract.list.view", "allow");
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("contracts").select("id").eq("id", contractId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("플랫폼 운영자는 무관한 센터의 계약서도 조회할 수 있다", async () => {
    const admin = getFixtureAdminClient();
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password); // centerA 권한 0개 상태 그대로
    const { error: flagErr } = await admin.from("accounts").update({ is_platform_admin: true }).eq("id", managerB.accountId);
    if (flagErr) throw new Error("platform admin 플래그 설정 실패: " + flagErr.message);
    try {
      const { data, error } = await supabase.from("contracts").select("id").eq("id", contractId!);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(1);
    } finally {
      // 플래그 원복은 assert 실패와 무관하게 항상 실행 — 안 그러면 이후 다른 테스트/파일의
      // "무권한이어야 함" 전제가 이 leftover 플래그 때문에 연쇄로 깨진다(이 저장소에서 실측된
      // 문제, auto-book-membership-security.test.ts AUTO-D와 동일 계열).
      await admin.from("accounts").update({ is_platform_admin: false }).eq("id", managerB.accountId);
    }
  });

  it("타 센터 오너(managerB가 centerB 관점에서)는 centerA의 계약서를 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("contracts").select("id").eq("center_id", centerAId).eq("id", contractId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("INSERT/UPDATE/DELETE는 오너를 포함해 누구에게도 허용되지 않는다(정책 없음 → 기본 거부)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password); // 오너
    const insertRes = await supabase
      .from("contracts")
      .insert({ center_id: centerAId, profile_id: userA.profileId, content: "차단돼야 함" });
    expect(insertRes.error).not.toBeNull();

    // RLS가 막은 UPDATE/DELETE는 에러 없이 매칭 0건으로 조용히 끝날 수 있으므로(이 저장소
    // 다른 통합테스트들과 동일 패턴), 에러 유무가 아니라 실제로 안 바뀌었는지로 판정한다.
    await supabase.from("contracts").update({ status: "cancelled" }).eq("id", contractId!);
    const { data: stillSigned } = await getFixtureAdminClient().from("contracts").select("status").eq("id", contractId!).single();
    expect((stillSigned as any)?.status).toBe("signed");

    await supabase.from("contracts").delete().eq("id", contractId!);
    const { data: stillExists } = await getFixtureAdminClient().from("contracts").select("id").eq("id", contractId!).maybeSingle();
    expect(stillExists).not.toBeNull(); // 실제로 안 지워졌는지 최종 확인
  });
});

describe("notification_logs — SELECT만 정책 (message.sms.view/message.push.view 중 하나만 있어도 그 센터 전체 발송기록 조회 허용, messages 테이블과 달리 채널로 안 나뉨 — docs/22_RLS_Gap_A2_Investigation.md 설계 그대로)", () => {
  it("무권한 스태프는 SMS/푸시 발송기록을 모두 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const sms = await supabase.from("notification_logs").select("id").eq("id", notifSmsId!);
    const push = await supabase.from("notification_logs").select("id").eq("id", notifPushId!);
    expect(sms.data ?? []).toHaveLength(0);
    expect(push.data ?? []).toHaveLength(0);
  });

  it("message.sms.view 권한이 있으면 SMS/푸시 발송기록을 둘 다 조회할 수 있다(채널 무관 — messages와 다른 설계)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await setStaffOverride(staffManagerCenterId, "message.sms.view", "allow");
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const sms = await supabase.from("notification_logs").select("id").eq("id", notifSmsId!);
    const push = await supabase.from("notification_logs").select("id").eq("id", notifPushId!);
    expect(sms.data ?? []).toHaveLength(1);
    expect(push.data ?? []).toHaveLength(1);
  });

  it("message.push.view 권한이 있으면 SMS/푸시 발송기록을 둘 다 조회할 수 있다(채널 무관 — messages와 다른 설계)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await setStaffOverride(staffManagerCenterId, "message.push.view", "allow");
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const sms = await supabase.from("notification_logs").select("id").eq("id", notifSmsId!);
    const push = await supabase.from("notification_logs").select("id").eq("id", notifPushId!);
    expect(sms.data ?? []).toHaveLength(1);
    expect(push.data ?? []).toHaveLength(1);
  });

  it("플랫폼 운영자는 무관한 센터의 발송기록도 조회할 수 있다", async () => {
    const admin = getFixtureAdminClient();
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { error: flagErr } = await admin.from("accounts").update({ is_platform_admin: true }).eq("id", managerB.accountId);
    if (flagErr) throw new Error("platform admin 플래그 설정 실패: " + flagErr.message);
    try {
      const { data, error } = await supabase.from("notification_logs").select("id").eq("id", notifSmsId!);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(1);
    } finally {
      await admin.from("accounts").update({ is_platform_admin: false }).eq("id", managerB.accountId);
    }
  });

  it("타 센터 오너(managerB가 centerB 관점에서)는 centerA의 발송기록을 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("notification_logs").select("id").eq("center_id", centerAId).eq("id", notifSmsId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("INSERT/UPDATE/DELETE는 오너를 포함해 누구에게도 허용되지 않는다(정책 없음 → 기본 거부, 서버 트리거 전용)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password); // 오너
    const insertRes = await supabase
      .from("notification_logs")
      .insert({ center_id: centerAId, profile_id: userA.profileId, channel: "sms", status: "sent" });
    expect(insertRes.error).not.toBeNull();

    await supabase.from("notification_logs").update({ status: "failed" }).eq("id", notifSmsId!);
    const { data: stillSent } = await getFixtureAdminClient().from("notification_logs").select("status").eq("id", notifSmsId!).single();
    expect((stillSent as any)?.status).toBe("sent");

    await supabase.from("notification_logs").delete().eq("id", notifSmsId!);
    const { data: stillExists } = await getFixtureAdminClient().from("notification_logs").select("id").eq("id", notifSmsId!).maybeSingle();
    expect(stillExists).not.toBeNull();
  });
});
