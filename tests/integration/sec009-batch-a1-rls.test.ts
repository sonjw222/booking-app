/*
  SEC-009 RLS Gap Batch A1 회귀 테스트.

  ⚠️ 이 파일은 proposed_rls_gap_batch_a1.sql이 실제로 Supabase에 적용되기 전에는
  의도적으로 FAIL해야 합니다(현재 3개 테이블 전부 정책 0건 → 오너를 포함해 아무도 접근
  불가, fixture 준비 단계에서부터 막힘). 승인 후 실행하면 이 파일이 green이 되어야 정상입니다.

  대상 테이블: staff_salaries, leads, messages (Batch A 5개 중 A1로 분리된 3개 —
  contracts/notification_logs는 A2로 별도 조사 중, docs/22_RLS_Gap_A2_Investigation.md 참고).
  Batch A를 A1/A2로 나눈 이유: 검증되지 않은 2개 테이블(contracts/notification_logs, fixture
  lifecycle이 막혀 통합 테스트가 없음)을 검증된 3개와 함께 적용하면 회귀 발생 시 원인 분리가
  어렵다는 지적(2026-08-02)에 따름.

  [2026-08-02 확인, 읽기 전용 진단] 개발(dev) Supabase에서 실제로 확인한 상태:
    - RLS는 3개 테이블 전부 이미 활성화(정책 0건 — "정책 0건"과 "RLS 비활성"은 Postgres에서
      서로 다른 별개 상태, SEC-007 문서의 최초 분류를 정정함). dev의 원래 상태는 "완전 차단"
      이지 "전체 공개"가 아니었다 — 당초 우려보다 안전했음. 운영(production) Supabase는 별도
      확인 안 됨(이 프로젝트는 현재 Supabase 프로젝트가 하나뿐이라 사실상 이것이 유일한
      환경일 가능성이 높지만, 확정은 아님).
    - GRANT는 anon/authenticated 둘 다 정상(SELECT 시도 시 에러 없이 0건 반환 — RLS가 막고
      있을 뿐 테이블 GRANT 자체는 있음, 즉 proposed_rls_gap_batch_a1.sql만으로 충분하고
      추가 GRANT는 필요 없음). service_role만 GRANT 없음(`permission denied for table X`,
      account_center_permissions에서 이미 겪은 것과 같은 패턴) — 앱 코드가 service_role을
      전혀 쓰지 않아(SEC-007 확인) 실제 보안과는 무관, 순수하게 테스트 도구(admin client)
      제약일 뿐이다. `staff_salaries`/`leads`/`messages`는 오너에게 INSERT+DELETE 정책이
      모두 있어 일반 로그인 오너 client로 fixture를 만들고 정리할 수 있으므로(적용 전인 지금은
      이 자체가 막혀서 red, 적용 후 green이 되는 정상 경로) service_role 없이도 문제 없다.

  Fixture: TEST_MANAGER_A(centerA 오너)/TEST_MANAGER_B(centerB 오너, centerA에는 권한 0개
  스태프로 초대)/TEST_USER_A(어느 센터에도 속하지 않은 일반 회원) 세 계정만 재사용한다
  (ACL-003/ACL-005와 동일 패턴 — 새 GitHub Secrets 없음). 이 파일이 생성한 모든 행/초대/
  권한 오버라이드는 afterAll에서 성공·실패와 무관하게 전부 정리한다(TEST-002 원칙).
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, type TestUser } from "./setup";
import { createRole, fetchRoles, inviteStaff, removeStaff, deleteRole, setStaffOverride } from "../../lib/roles";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const USER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

const NO_PERM_ROLE_NAME = "SEC-009 Batch A1 테스트 무권한 역할";

let managerA: TestUser;
let managerB: TestUser;
let userA: TestUser;
let centerAId: string;
let staffManagerCenterId: string; // centerA에서 managerB(비오너 스태프)의 manager_centers.id

// 이번 실행이 실제로 "새로 만든" 것만 기록 — afterAll에서 이것만 정리한다.
let createdRoleId: string | null = null;
let createdStaffManagerCenterId: string | null = null;

// 이 파일 전용으로 생성한 테스트 행 id들
let staffSalaryOwnId: string | null = null; // managerA 본인 급여 행
let staffSalaryOtherId: string | null = null; // managerB(스태프) 급여 행
let leadId: string | null = null;
let messageSmsId: string | null = null;
let messagePushId: string | null = null;

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
  await getOrCreateOwnedTestCenter(managerB); // centerB — managerB를 "타 센터 오너" 페르소나로도 쓰기 위해 보장만 해둠

  userA = await switchToTestUser(USER_A.email, USER_A.password);

  // managerA(오너)로 돌아와 managerB를 centerA에 무권한 스태프로 초대하고, 테스트용 행을 만든다.
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const role = await getOrCreateNoPermRole(centerAId);
  if (role.created) createdRoleId = role.id;

  const invited = await inviteIfNeeded(centerAId, managerB.accountId, role.id);
  staffManagerCenterId = await managerCenterIdFor(centerAId, managerB.accountId);
  if (invited) createdStaffManagerCenterId = staffManagerCenterId;

  // 아래 3개 테이블은 오너에게 INSERT 정책이 있으므로(proposed_rls_gap_batch_a1.sql 적용 후)
  // managerA(오너)의 일반 로그인 client로 fixture를 만든다 — 적용 전인 지금은 이 자체가
  // 막혀서 여기서 바로 실패하는 것이 정상(red)이다.
  {
    const { data, error } = await supabase
      .from("staff_salaries")
      .insert({ center_id: centerAId, account_id: managerA.accountId, employment_type: "fulltime", base_salary: 3000000 })
      .select("id").single();
    if (error) throw new Error("staff_salaries(own) fixture 생성 실패: " + error.message);
    staffSalaryOwnId = (data as { id: string }).id;
  }
  {
    const { data, error } = await supabase
      .from("staff_salaries")
      .insert({ center_id: centerAId, account_id: managerB.accountId, employment_type: "parttime", per_class_pay: 30000 })
      .select("id").single();
    if (error) throw new Error("staff_salaries(other) fixture 생성 실패: " + error.message);
    staffSalaryOtherId = (data as { id: string }).id;
  }
  {
    const { data, error } = await supabase
      .from("leads")
      .insert({ center_id: centerAId, name: "SEC-009 배치A1 테스트 상담고객", phone: "010-0000-0000", channel: "test" })
      .select("id").single();
    if (error) throw new Error("leads fixture 생성 실패: " + error.message);
    leadId = (data as { id: string }).id;
  }
  {
    const { data, error } = await supabase
      .from("messages")
      .insert({ center_id: centerAId, channel: "sms", content: "SEC-009 배치A1 테스트 SMS", status: "sent" })
      .select("id").single();
    if (error) throw new Error("messages(sms) fixture 생성 실패: " + error.message);
    messageSmsId = (data as { id: string }).id;
  }
  {
    const { data, error } = await supabase
      .from("messages")
      .insert({ center_id: centerAId, channel: "push", title: "SEC-009 배치A1", content: "SEC-009 배치A1 테스트 푸시", status: "sent" })
      .select("id").single();
    if (error) throw new Error("messages(push) fixture 생성 실패: " + error.message);
    messagePushId = (data as { id: string }).id;
  }
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];

  const deleteRow = async (table: string, id: string | null, label: string) => {
    if (!id) return;
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) errors.push(`${label} 정리 실패(id=${id}): ${error.message}`);
  };

  await deleteRow("staff_salaries", staffSalaryOwnId, "staff_salaries(own)");
  await deleteRow("staff_salaries", staffSalaryOtherId, "staff_salaries(other)");
  await deleteRow("leads", leadId, "leads");
  await deleteRow("messages", messageSmsId, "messages(sms)");
  await deleteRow("messages", messagePushId, "messages(push)");

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
    throw new Error(`SEC-009 Batch A1 fixture cleanup 실패 — 공유 개발 DB에 잔여 데이터가 남았을 수 있습니다:\n${errors.join("\n")}`);
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
      // 이 단계까지 왔다는 건 이미 정책이 적용돼 managerA로는 정상 delete가 되는 상태라는 뜻이므로
      // 실수로 성공했을 경우 managerA(오너)로 전환해 바로 정리한다.
      const insertedId = (data as { id: string }[] | null)?.[0]?.id;
      if (insertedId) {
        await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
        await supabase.from("staff_salaries").delete().eq("id", insertedId);
      }
    }
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
