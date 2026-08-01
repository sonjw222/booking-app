/*
  SEC-007/008 RLS Gap Batch A 회귀 테스트.

  ⚠️ 이 파일은 proposed_rls_gap_batch_a.sql이 실제로 Supabase에 적용되기 전에는
  의도적으로 FAIL해야 합니다.

  [2026-08-02 정정] SEC-007 문서는 이 5개 테이블을 "RLS가 없거나 정책 0건"으로 분류했지만,
  실제 개발(dev) Supabase에서 재확인한 결과 5개 테이블 전부 RLS는 이미 활성화되어 있고
  정책만 0건이었다(완전 차단 — 오너를 포함해 아무도 접근 불가. "정책 0건"과 "RLS 비활성"은
  서로 다른 별개 상태다). 그래서 이 테스트의 fixture 생성/정리는 일반 로그인 client가 아니라
  RLS를 우회하는 service-role admin client(getFixtureAdminClient(), getOrCreateOwnedTestCenter와
  동일한 패턴)로 한다 — 그래야 정책이 아직 없는 지금도 fixture를 만들 수 있다. 실제 검증
  assertion(각 it() 블록)만 일반 로그인 client로 실행해 진짜 RLS 동작을 확인한다.
  proposed_rls_gap_batch_a.sql을 승인 후 실행하면 이 파일이 green이 되어야 정상입니다.

  대상 테이블: staff_salaries, contracts, leads, messages, notification_logs
  (docs/21_RLS_Gap_Analysis.md "단계 적용 계획" Batch A, "Critical/High 민감정보 최우선")

  Fixture: TEST_MANAGER_A(centerA 오너)/TEST_MANAGER_B(centerB 오너, centerA에는 권한 0개
  스태프로 초대)/TEST_USER_A(어느 센터에도 속하지 않은 일반 회원) 세 계정만 재사용한다
  (ACL-003/ACL-005와 동일 패턴 — 새 GitHub Secrets 없음, docs/21_RLS_Gap_Analysis.md
  "Fixture 요구사항" 참고). 이 파일이 생성한 모든 행/초대/권한 오버라이드는 afterAll에서
  성공·실패와 무관하게 전부 정리한다(TEST-002에서 배운 원칙 — 생성한 것만 정확히 추적해
  지우고, 실행 전부터 있던 데이터는 건드리지 않는다).
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  describeAdminQueryError,
  type TestUser,
} from "./setup";
import { createRole, fetchRoles, inviteStaff, removeStaff, deleteRole, setStaffOverride } from "../../lib/roles";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const USER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

const NO_PERM_ROLE_NAME = "SEC-007 Batch A 테스트 무권한 역할";

let managerA: TestUser;
let managerB: TestUser;
let userA: TestUser;
let centerAId: string;
let centerBId: string;
let staffManagerCenterId: string; // centerA에서 managerB(비오너 스태프)의 manager_centers.id

// 이번 실행이 실제로 "새로 만든" 것만 기록 — afterAll에서 이것만 정리한다.
let createdRoleId: string | null = null;
let createdStaffManagerCenterId: string | null = null;

// 이 파일 전용으로 생성한 테스트 행 id들
let staffSalaryOwnId: string | null = null; // managerA 본인 급여 행
let staffSalaryOtherId: string | null = null; // managerB(스태프) 급여 행
let contractOwnerRowId: string | null = null; // managerA 본인 profile 계약서
let contractMemberRowId: string | null = null; // userA(무관 회원) profile 계약서
let leadId: string | null = null;
let messageSmsId: string | null = null;
let messagePushId: string | null = null;
let notificationLogId: string | null = null;

async function getOrCreateNoPermRole(centerId: string): Promise<{ id: string; created: boolean }> {
  const roles = await fetchRoles(centerId);
  const existing = roles.find((r) => r.name === NO_PERM_ROLE_NAME);
  if (existing) return { id: existing.id, created: false };
  await createRole(centerId, NO_PERM_ROLE_NAME);
  const refreshed = await fetchRoles(centerId);
  const created = refreshed.find((r) => r.name === NO_PERM_ROLE_NAME);
  if (!created) throw new Error("무권한 역할 생성에 실패했어요");
  return { id: created.id, created: true };
}

async function inviteIfNeeded(centerId: string, accountId: string, roleId: string): Promise<boolean> {
  try {
    await inviteStaff(centerId, accountId, roleId);
    return true;
  } catch (e: any) {
    if (e.message.includes("이미 이 센터의 스태프")) return false;
    throw e;
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

// 매 테스트 후 managerB의 centerA 권한 오버라이드를 전부 원상복구(0개 권한 상태로) —
// 이 파일 전용으로 새로 만든 staffManagerCenterId 행에만 거는 값이라 안전하게 매번 초기화한다.
const BATCH_A_KEYS = [
  "facility.salary.own.view",
  "facility.salary.other.view",
  "contract.list.view",
  "customer.lead.view",
  "message.sms.view",
  "message.push.view",
];
async function clearManagerBOverrides() {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  for (const key of BATCH_A_KEYS) {
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
  centerBId = await getOrCreateOwnedTestCenter(managerB);

  userA = await switchToTestUser(USER_A.email, USER_A.password);

  // managerA(오너)로 돌아와 managerB를 centerA에 무권한 스태프로 초대하고, 테스트용 행을 만든다.
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const role = await getOrCreateNoPermRole(centerAId);
  if (role.created) createdRoleId = role.id;

  const invited = await inviteIfNeeded(centerAId, managerB.accountId, role.id);
  staffManagerCenterId = await managerCenterIdFor(centerAId, managerB.accountId);
  if (invited) createdStaffManagerCenterId = staffManagerCenterId;

  // 아래 fixture 행들은 전부 RLS를 우회하는 admin(service-role) client로 생성한다 —
  // 대상 테이블이 정책 0건(=현재 오너 포함 아무도 접근 불가)이라 일반 로그인 client로는
  // 지금 당장 만들 수 없다(위 파일 헤더의 2026-08-02 정정 참고). 5개 테이블 각각을
  // 독립적으로 시도해 에러를 모으고, 하나라도 실패하면 전체를 한 번에 보고한다 —
  // service_role의 GRANT 자체가 테이블마다 다를 수 있어(2026-08-02 발견, staff_salaries에서
  // 실제로 GRANT 누락 확인) 첫 실패에서 즉시 멈추면 나머지 테이블 상태를 알 수 없다.
  const admin = getFixtureAdminClient();
  const fixtureErrors: string[] = [];

  async function insertFixture<T extends Record<string, unknown>>(
    table: string,
    row: T,
    assign: (id: string) => void
  ): Promise<void> {
    const { data, error } = await admin.from(table).insert(row).select("id").single();
    if (error) {
      fixtureErrors.push(`${table} fixture 생성 실패: ${describeAdminQueryError(table, error)}`);
      return;
    }
    assign((data as { id: string }).id);
  }

  // staff_salaries — own/other 분리 검증용으로 managerA/managerB 두 행 모두 생성
  await insertFixture(
    "staff_salaries",
    { center_id: centerAId, account_id: managerA.accountId, employment_type: "fulltime", base_salary: 3000000 },
    (id) => { staffSalaryOwnId = id; }
  );
  await insertFixture(
    "staff_salaries",
    { center_id: centerAId, account_id: managerB.accountId, employment_type: "parttime", per_class_pay: 30000 },
    (id) => { staffSalaryOtherId = id; }
  );

  // contracts — managerA 본인 profile 것 1건 + 어느 센터에도 안 속한 userA(일반 회원) profile 것 1건
  // (userA 것은 "본인 것" OR-branch를 오너 특권과 분리해서 검증하기 위한 fixture)
  await insertFixture(
    "contracts",
    { center_id: centerAId, profile_id: managerA.profileId, content: "SEC-007 배치A 테스트 계약서(오너 본인)", status: "pending" },
    (id) => { contractOwnerRowId = id; }
  );
  await insertFixture(
    "contracts",
    { center_id: centerAId, profile_id: userA.profileId, content: "SEC-007 배치A 테스트 계약서(일반 회원 본인)", status: "pending" },
    (id) => { contractMemberRowId = id; }
  );

  // leads
  await insertFixture(
    "leads",
    { center_id: centerAId, name: "SEC-007 배치A 테스트 상담고객", phone: "010-0000-0000", channel: "test" },
    (id) => { leadId = id; }
  );

  // messages — sms/push 채널별 분리 검증용으로 두 행
  await insertFixture(
    "messages",
    { center_id: centerAId, channel: "sms", content: "SEC-007 배치A 테스트 SMS", status: "sent" },
    (id) => { messageSmsId = id; }
  );
  await insertFixture(
    "messages",
    { center_id: centerAId, channel: "push", title: "SEC-007 배치A", content: "SEC-007 배치A 테스트 푸시", status: "sent" },
    (id) => { messagePushId = id; }
  );

  // notification_logs
  await insertFixture(
    "notification_logs",
    { center_id: centerAId, profile_id: managerA.profileId, channel: "sms", cost: 15, status: "sent" },
    (id) => { notificationLogId = id; }
  );

  if (fixtureErrors.length > 0) {
    throw new Error(`SEC-007 Batch A fixture 생성 실패(${fixtureErrors.length}건):\n${fixtureErrors.join("\n")}`);
  }
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];

  const admin = getFixtureAdminClient();
  const deleteRow = async (table: string, id: string | null, label: string) => {
    if (!id) return;
    // 정책이 아직 없는 동안은 오너(managerA)도 delete가 막히므로 admin client로 정리한다.
    const { error } = await admin.from(table).delete().eq("id", id);
    if (error) errors.push(`${label} 정리 실패(id=${id}): ${describeAdminQueryError(table, error)}`);
  };

  await deleteRow("staff_salaries", staffSalaryOwnId, "staff_salaries(own)");
  await deleteRow("staff_salaries", staffSalaryOtherId, "staff_salaries(other)");
  await deleteRow("contracts", contractOwnerRowId, "contracts(owner)");
  await deleteRow("contracts", contractMemberRowId, "contracts(member)");
  await deleteRow("leads", leadId, "leads");
  await deleteRow("messages", messageSmsId, "messages(sms)");
  await deleteRow("messages", messagePushId, "messages(push)");
  await deleteRow("notification_logs", notificationLogId, "notification_logs");

  try {
    await clearManagerBOverrides();
  } catch (e: any) {
    errors.push(`권한 오버라이드 정리 실패: ${e.message}`);
  }

  if (createdStaffManagerCenterId) {
    try {
      await removeStaff(createdStaffManagerCenterId);
    } catch (e: any) {
      errors.push(`manager_centers 정리 실패(id=${createdStaffManagerCenterId}): ${e.message}`);
    }
  }
  if (createdRoleId) {
    try {
      await deleteRole(createdRoleId);
    } catch (e: any) {
      errors.push(`역할 정리 실패(id=${createdRoleId}): ${e.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`SEC-007 Batch A fixture cleanup 실패 — 공유 개발 DB에 잔여 데이터가 남았을 수 있습니다:\n${errors.join("\n")}`);
  }
}, 30000);

describe("staff_salaries — 본인/타인 권한 완전 분리", () => {
  it("무권한 스태프는 자기 자신의 급여 행도 볼 수 없다(own.view 권한 없이는 본인도 차단)", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("staff_salaries").select("id").eq("id", staffSalaryOtherId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("무권한 스태프는 다른 사람(오너)의 급여 행을 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("staff_salaries").select("id").eq("id", staffSalaryOwnId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("facility.salary.own.view가 있으면 본인 행은 보이지만 남의 행은 여전히 안 보인다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await setStaffOverride(staffManagerCenterId, "facility.salary.own.view", "allow");
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const own = await supabase.from("staff_salaries").select("id").eq("id", staffSalaryOtherId!);
    const other = await supabase.from("staff_salaries").select("id").eq("id", staffSalaryOwnId!);
    expect(own.data ?? []).toHaveLength(1);
    expect(other.data ?? []).toHaveLength(0);
  });

  it("facility.salary.other.view가 있으면 남의 행은 보이지만 own.view 없이는 본인 행이 안 보인다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await setStaffOverride(staffManagerCenterId, "facility.salary.other.view", "allow");
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const own = await supabase.from("staff_salaries").select("id").eq("id", staffSalaryOtherId!);
    const other = await supabase.from("staff_salaries").select("id").eq("id", staffSalaryOwnId!);
    expect(own.data ?? []).toHaveLength(0);
    expect(other.data ?? []).toHaveLength(1);
  });

  it("무권한 스태프는 급여 행을 새로 만들 수 없다", async () => {
    // managerB/managerA 몫은 beforeAll에서 이미 만들어 unique(center_id,account_id)에 걸리므로,
    // 아직 이 센터에 급여 행이 없는 userA를 대상으로 시도해 순수하게 RLS만 검증한다.
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase
      .from("staff_salaries")
      .insert({ center_id: centerAId, account_id: userA.accountId, employment_type: "substitute", per_class_pay: 10000 })
      .select("id");
    try {
      expect(error).not.toBeNull();
    } finally {
      // SQL 적용 전(RLS 없음)에는 이 insert가 실제로 성공해 행이 생길 수 있다 — 그 경우도 정리한다.
      const insertedId = (data as { id: string }[] | null)?.[0]?.id;
      if (insertedId) await getFixtureAdminClient().from("staff_salaries").delete().eq("id", insertedId);
    }
  });
});

describe("contracts — 서명 계약서 (본인 조회 또는 list.view 권한)", () => {
  it("타인(무관한 일반 회원)의 계약서는 무권한 스태프에게 보이지 않는다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("contracts").select("id").eq("id", contractMemberRowId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("본인(userA)은 자기 자신의 계약서를 권한 없이도 조회할 수 있다", async () => {
    await switchToTestUser(USER_A.email, USER_A.password);
    const { data, error } = await supabase.from("contracts").select("id").eq("id", contractMemberRowId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("contract.list.view 권한이 있으면 타인의 계약서도 조회할 수 있다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await setStaffOverride(staffManagerCenterId, "contract.list.view", "allow");
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("contracts").select("id").eq("id", contractMemberRowId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("서명 완료 여부와 무관하게 클라이언트에서 직접 UPDATE할 수 없다(정책 없음 → 기본 거부)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const { error } = await supabase.from("contracts").update({ status: "signed" }).eq("id", contractOwnerRowId!);
    // 정책이 아예 없으므로 UPDATE는 0행 영향(RLS가 대상 행을 하나도 못 찾음) — 에러 없이 조용히 0건이거나 명시적 에러
    const { data: check } = await supabase.from("contracts").select("status").eq("id", contractOwnerRowId!).single();
    expect(check?.status).not.toBe("signed");
  });
});

describe("leads — 상담고객 (permission key 그대로)", () => {
  it("무권한 스태프는 상담고객 목록을 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("leads").select("id").eq("id", leadId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("customer.lead.view 권한이 있으면 상담고객을 조회할 수 있다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await setStaffOverride(staffManagerCenterId, "customer.lead.view", "allow");
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("leads").select("id").eq("id", leadId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("타 센터 오너(managerB가 centerB 관점에서)는 centerA의 상담고객을 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    // centerB 오너 권한으로는 centerA 데이터에 아무 영향이 없음 — leadId는 centerA 소속
    const { data, error } = await supabase.from("leads").select("id").eq("center_id", centerAId).eq("id", leadId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});

describe("messages — 발송이력 (채널별 permission key 분리)", () => {
  it("무권한 스태프는 SMS/푸시 발송이력을 모두 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const sms = await supabase.from("messages").select("id").eq("id", messageSmsId!);
    const push = await supabase.from("messages").select("id").eq("id", messagePushId!);
    expect(sms.data ?? []).toHaveLength(0);
    expect(push.data ?? []).toHaveLength(0);
  });

  it("message.sms.view 권한이 있으면 SMS만 보이고 푸시는 여전히 안 보인다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await setStaffOverride(staffManagerCenterId, "message.sms.view", "allow");
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const sms = await supabase.from("messages").select("id").eq("id", messageSmsId!);
    const push = await supabase.from("messages").select("id").eq("id", messagePushId!);
    expect(sms.data ?? []).toHaveLength(1);
    expect(push.data ?? []).toHaveLength(0);
  });
});

describe("notification_logs — 알림발송기록 (정산 데이터, ACL-003 재검증 이후 강화)", () => {
  it("무권한 스태프는 알림발송기록을 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("notification_logs").select("id").eq("id", notificationLogId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("message.sms.view 또는 message.push.view 권한이 있으면 조회할 수 있다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await setStaffOverride(staffManagerCenterId, "message.push.view", "allow");
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase.from("notification_logs").select("id").eq("id", notificationLogId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("클라이언트에서 직접 INSERT할 수 없다(서버 트리거 전용, 정책 없음 → 기본 거부)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const { data, error } = await supabase
      .from("notification_logs")
      .insert({ center_id: centerAId, channel: "sms", cost: 0 })
      .select("id");
    try {
      expect(error).not.toBeNull();
    } finally {
      // SQL 적용 전(RLS 없음)에는 이 insert가 실제로 성공해 행이 생길 수 있다 — 그 경우도 정리한다.
      const insertedId = (data as { id: string }[] | null)?.[0]?.id;
      if (insertedId) await getFixtureAdminClient().from("notification_logs").delete().eq("id", insertedId);
    }
  });
});
