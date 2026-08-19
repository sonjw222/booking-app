/*
  P1-8: 상담고객(leads) CRUD + RLS 검증.
  leads 테이블/RLS(customer.lead.*)는 다른 세션의 이전 배치에서 이미 라이브 적용돼 있었다
  (proposed_rls_gap_batch_a1.sql) — 이 파일은 이번에 새로 만든 화면(app/manager/leads)이
  기대하는 lib/leads.ts 동작이 실제 RLS와 맞물려 정확히 동작하는지 검증한다.

  Fixture는 acl-003-permission-read.test.ts와 동일한 패턴: MANAGER_B를 centerA에 권한 0개인
  역할로 초대해 "일반 스태프"로 쓴다.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, type TestUser } from "./setup";
import { createRole, inviteStaff, removeStaff, deleteRole, setStaffOverride } from "../../lib/roles";
import { fetchLeads, createLead, updateLead, updateLeadStatus, deleteLead } from "../../lib/leads";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

const ROLE_NAME = "P1-8 테스트 무권한 역할";

let managerA: TestUser;
let managerB: TestUser;
let centerAId: string;
let roleId: string | null = null;
let staffManagerCenterId: string | null = null;

const createdLeadIds: string[] = [];

async function asManagerA() {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
}
async function asManagerB() {
  await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);

  await asManagerA();
  const { data: existingRole } = await supabase
    .from("center_roles").select("id").eq("center_id", centerAId).eq("name", ROLE_NAME).maybeSingle();
  if (existingRole) {
    roleId = existingRole.id;
  } else {
    await createRole(centerAId, ROLE_NAME);
    const { data: created } = await supabase
      .from("center_roles").select("id").eq("center_id", centerAId).eq("name", ROLE_NAME).single();
    roleId = created!.id;
  }

  const { data: existingStaff } = await supabase
    .from("manager_centers").select("id").eq("center_id", centerAId).eq("account_id", managerB.accountId).maybeSingle();
  if (existingStaff) {
    staffManagerCenterId = existingStaff.id;
  } else {
    await inviteStaff(centerAId, managerB.accountId, roleId!);
    const { data: created } = await supabase
      .from("manager_centers").select("id").eq("center_id", centerAId).eq("account_id", managerB.accountId).single();
    staffManagerCenterId = created!.id;
  }
}, 30000);

afterAll(async () => {
  await asManagerA();
  for (const id of createdLeadIds) {
    try { await deleteLead(id); } catch { /* 이미 지워졌으면 무시 */ }
  }
  if (staffManagerCenterId) { try { await removeStaff(staffManagerCenterId); } catch { /* 무시 */ } }
  if (roleId) { try { await deleteRole(roleId); } catch { /* 무시 */ } }
}, 30000);

beforeEach(async () => {
  await asManagerA();
});

describe("P1-8: 상담고객(leads) CRUD — 오너", () => {
  it("등록 → 조회 → 수정 → 상태변경 → 삭제까지 정상 동작한다", async () => {
    await createLead(centerAId, { name: "테스트 상담고객", phone: "010-1234-5678", channel: "인스타", memo: "체험 문의" });

    const list = await fetchLeads(centerAId);
    const created = list.find((l) => l.name === "테스트 상담고객");
    expect(created).toBeTruthy();
    expect(created!.status).toBe("new");
    expect(created!.phone).toBe("010-1234-5678");
    createdLeadIds.push(created!.id);

    await updateLead(created!.id, { name: "테스트 상담고객(수정)", phone: "010-1234-5678", channel: "인스타", memo: "체험 문의 완료" });
    await updateLeadStatus(created!.id, "contacted");

    const afterUpdate = (await fetchLeads(centerAId)).find((l) => l.id === created!.id);
    expect(afterUpdate!.name).toBe("테스트 상담고객(수정)");
    expect(afterUpdate!.status).toBe("contacted");

    await deleteLead(created!.id);
    createdLeadIds.splice(createdLeadIds.indexOf(created!.id), 1);
    const afterDelete = (await fetchLeads(centerAId)).find((l) => l.id === created!.id);
    expect(afterDelete).toBeUndefined();
  });
});

describe("P1-8: 상담고객(leads) — 권한 없는 스태프는 RLS로 차단된다", () => {
  it("customer.lead.view 없는 스태프는 목록이 빈 배열로 보인다(RLS가 조용히 필터링)", async () => {
    await createLead(centerAId, { name: "권한테스트용", phone: "", channel: "", memo: "" });
    const created = (await fetchLeads(centerAId)).find((l) => l.name === "권한테스트용");
    expect(created).toBeTruthy();
    createdLeadIds.push(created!.id);

    await asManagerB();
    const staffView = await fetchLeads(centerAId);
    expect(staffView.find((l) => l.id === created!.id)).toBeUndefined();
  });

  it("customer.lead.create 없는 스태프는 등록이 거부된다", async () => {
    await asManagerB();
    await expect(createLead(centerAId, { name: "차단되어야함", phone: "", channel: "", memo: "" })).rejects.toThrow();
  });

  it("customer.lead.view를 부여하면 같은 스태프가 목록을 볼 수 있다", async () => {
    await createLead(centerAId, { name: "권한부여테스트", phone: "", channel: "", memo: "" });
    const created = (await fetchLeads(centerAId)).find((l) => l.name === "권한부여테스트");
    expect(created).toBeTruthy();
    createdLeadIds.push(created!.id);

    await setStaffOverride(staffManagerCenterId!, "customer.lead.view", "allow");

    await asManagerB();
    const staffView = await fetchLeads(centerAId);
    expect(staffView.find((l) => l.id === created!.id)).toBeTruthy();

    await asManagerA();
    await setStaffOverride(staffManagerCenterId!, "customer.lead.view", null);
  });
});
