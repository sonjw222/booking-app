/*
  P0-8 후속: add_subscription_plan_limits.sql이 만든 4종 트리거
  (enforce_room_limit/enforce_staff_limit/enforce_member_limit/enforce_product_limit)와
  set_default_subscription_plan() RPC를 실제 DB에 대고 검증한다.

  공유 테스트센터(getOrCreateOwnedTestCenter)를 쓰지 않는다 — 이 파일은 센터의
  구독 플랜 자체를 반복적으로 바꿔가며 "제한 0/1/무제한" 경계를 테스트하는데, 공유
  센터에 그렇게 하면 같은 시각 다른 세션의 통합테스트가 그 센터에 룸/스태프/회원/상품을
  만들려다 우리가 건 임시 제한에 걸려 실패할 위험이 있다(이 저장소가 여러 세션이 동시에
  같은 개발용 Supabase를 쓰는 구조라는 점, 그리고 이 파일 자체가 "제한을 실제로 강제
  하는지" 검증하는 파일이라는 점 둘 다 고려한 설계). 대신 managerA 명의로 전용 센터를
  새로 등록해(registerCenterForAccount) 그 센터에만 영향을 주고, afterAll에서 전부
  정리한다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { registerCenterForAccount } from "../../lib/centers";
import { createRole, inviteStaff, removeStaff } from "../../lib/roles";
import { addRoom } from "../../lib/rooms";
import { addMemberToCenter } from "../../lib/members";
import { createProduct } from "../../lib/passes";
import { getFixtureAdminClient, switchToTestUser, signOutTestSession, type TestUser } from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };
const USER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };

let managerA: TestUser;
let managerB: TestUser;
let userA: TestUser;

let centerId: string;
let staffRoleId: string;
let qaPlanId: string;
let defaultPlanId: string; // 기존 is_default 플랜 — G 테스트 후 반드시 원복

async function asManagerA() { managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password); }

// 이 센터의 구독을 QA 테스트 플랜으로 바꾸고, 그 플랜의 제한값만 갱신(admin/service_role,
// RLS 우회 — 실제 화면 코드가 아니라 트리거 자체를 검증하는 fixture 준비 단계라 직접 씀).
async function setQaPlanLimits(limits: {
  maxRooms?: number | null; maxStaff?: number | null; maxMembers?: number | null; maxProducts?: number | null;
}) {
  const admin = getFixtureAdminClient();
  const patch: Record<string, number | null> = {};
  if ("maxRooms" in limits) patch.max_rooms = limits.maxRooms!;
  if ("maxStaff" in limits) patch.max_staff = limits.maxStaff!;
  if ("maxMembers" in limits) patch.max_members = limits.maxMembers!;
  if ("maxProducts" in limits) patch.max_products = limits.maxProducts!;
  const { error } = await admin.from("subscription_plans").update(patch).eq("id", qaPlanId);
  if (error) throw new Error("QA 플랜 제한 갱신 실패: " + error.message);
}

beforeAll(async () => {
  await asManagerA();
  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  userA = await switchToTestUser(USER_A.email, USER_A.password);
  await asManagerA(); // 이후 센터 등록/룸/상품 조작은 managerA 세션으로

  // 전용 격리 센터 생성(공유 fixture 센터 사용 안 함 — 파일 상단 설명 참고)
  const businessNumber = `QA-PLAN-LIMIT-${Date.now()}`;
  const { centerId: newCenterId } = await registerCenterForAccount({
    name: `P0-8 플랜제한 테스트센터-${Date.now()}`,
    address: "테스트 주소",
    phone: "010-0000-0000",
    businessNumber,
    licenseFile: null,
    licenseFileName: "test-license.pdf",
  });
  centerId = newCenterId;

  const admin = getFixtureAdminClient();

  // 트리거가 자동 배정한 기존 기본 플랜 id를 기억해둔다(G 테스트에서 반드시 원복)
  const { data: defaultPlanRow, error: defaultPlanErr } = await admin
    .from("subscription_plans").select("id").eq("is_default", true).single();
  if (defaultPlanErr || !defaultPlanRow) throw new Error("기존 기본 플랜을 찾지 못했어요: " + defaultPlanErr?.message);
  defaultPlanId = defaultPlanRow.id;

  // 이 파일 전용 QA 플랜(비활성 — 다른 화면/목록에 안 뜨게) 생성, 전부 무제한으로 시작
  const { data: qaPlan, error: qaPlanErr } = await admin
    .from("subscription_plans")
    .insert({
      name: `QA 테스트 제한 플랜-${Date.now()}`, monthly_price: 0, is_active: false,
      max_rooms: null, max_staff: null, max_members: null, max_products: null,
    })
    .select("id").single();
  if (qaPlanErr || !qaPlan) throw new Error("QA 플랜 생성 실패: " + qaPlanErr?.message);
  qaPlanId = qaPlan.id;

  // 이 센터의 구독을 QA 플랜으로 전환
  const { error: subErr } = await admin
    .from("center_subscriptions").update({ plan_id: qaPlanId }).eq("center_id", centerId);
  if (subErr) throw new Error("센터 구독 전환 실패: " + subErr.message);

  // 스태프 초대 테스트용 비-오너 역할
  await createRole(centerId, "QA 테스트 스태프 역할");
  const { data: roleRow, error: roleErr } = await admin
    .from("center_roles").select("id").eq("center_id", centerId).eq("name", "QA 테스트 스태프 역할").single();
  if (roleErr || !roleRow) throw new Error("역할 조회 실패: " + roleErr?.message);
  staffRoleId = roleRow.id;
}, 60000);

afterAll(async () => {
  await asManagerA();
  const admin = getFixtureAdminClient();
  // 기본 플랜 원복 — "기본 플랜 지정 RPC" describe 블록이 이미 자체 finally에서 원복하지만,
  // 그 테스트 자체가 실패로 끝났을 경우까지 대비해 여기서도 한 번 더 확실히 되돌린다.
  // set_default_subscription_plan() RPC는 is_platform_admin() 체크가 있어 service_role
  // 세션(auth.uid() 없음)으로는 못 부르므로, 정리 단계에 한해 service_role로 직접 UPDATE
  // 2번 사용(실제 제품 코드 경로가 아니라 테스트가 스스로 어지른 전역 상태를 되돌리는 것뿐).
  await admin.from("subscription_plans").update({ is_default: false }).neq("id", defaultPlanId);
  await admin.from("subscription_plans").update({ is_default: true }).eq("id", defaultPlanId);

  if (centerId) {
    await admin.from("products").delete().eq("center_id", centerId);
    await admin.from("rooms").delete().eq("center_id", centerId);
    await admin.from("center_members").delete().eq("center_id", centerId);
    await admin.from("manager_centers").delete().eq("center_id", centerId);
    await admin.from("center_roles").delete().eq("center_id", centerId);
    await admin.from("center_subscriptions").delete().eq("center_id", centerId);
    await admin.from("centers").delete().eq("id", centerId);
  }
  if (qaPlanId) {
    await admin.from("subscription_plans").delete().eq("id", qaPlanId);
  }
  await signOutTestSession();
}, 60000);

describe("센터 생성 시 기본 플랜 자동 배정", () => {
  it("신규 센터는 center_subscriptions 행이 자동 생성된다(트리거)", async () => {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin.from("center_subscriptions").select("id, plan_id").eq("center_id", centerId).single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });
});

describe("룸 개수 제한", () => {
  it("제한 0이면 첫 번째 룸부터 막힌다", async () => {
    await setQaPlanLimits({ maxRooms: 0 });
    await expect(addRoom(centerId, { name: "테스트룸", memo: "", address: "", latitude: null, longitude: null }))
      .rejects.toThrow(/룸.*최대.*0개/);
  });

  it("제한 1이면 1개까지 성공하고 2번째부터 막힌다", async () => {
    await setQaPlanLimits({ maxRooms: 1 });
    await addRoom(centerId, { name: "테스트룸1", memo: "", address: "", latitude: null, longitude: null });
    await expect(addRoom(centerId, { name: "테스트룸2", memo: "", address: "", latitude: null, longitude: null }))
      .rejects.toThrow(/룸.*최대.*1개/);
  });

  it("무제한(null)이면 여러 개 만들어도 막히지 않는다", async () => {
    await setQaPlanLimits({ maxRooms: null });
    // 바로 앞 테스트에서 제한 1로 이미 1개가 있는 상태 — 무제한이면 추가로 2개 더 만들어도
    // (총 3개) 에러 없이 전부 성공해야 한다.
    await addRoom(centerId, { name: "테스트룸3", memo: "", address: "", latitude: null, longitude: null });
    await addRoom(centerId, { name: "테스트룸4", memo: "", address: "", latitude: null, longitude: null });
    const admin = getFixtureAdminClient();
    const { data, error } = await admin.from("rooms").select("id").eq("center_id", centerId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("스태프 수 제한 (오너 제외)", () => {
  it("제한 0이면 첫 스태프 초대부터 막힌다", async () => {
    await setQaPlanLimits({ maxStaff: 0 });
    await expect(inviteStaff(centerId, managerB.accountId, staffRoleId)).rejects.toThrow(/스태프.*최대.*0명/);
  });

  it("제한 1이면 오너는 슬롯을 소비하지 않아 첫 스태프는 성공하고, 2번째부터 막힌다", async () => {
    await setQaPlanLimits({ maxStaff: 1 });
    await inviteStaff(centerId, managerB.accountId, staffRoleId); // 오너(managerA)가 이미 있어도 이건 성공해야 함
    await expect(inviteStaff(centerId, userA.accountId, staffRoleId)).rejects.toThrow(/스태프.*최대.*1명/);

    // 정리(다음 테스트가 "제한 0"부터 다시 시작할 수 있게)
    const admin = getFixtureAdminClient();
    const { data: staffRow } = await admin
      .from("manager_centers").select("id").eq("center_id", centerId).eq("account_id", managerB.accountId).maybeSingle();
    if (staffRow) await removeStaff(staffRow.id);
  });
});

describe("회원 수 제한", () => {
  it("제한 0이면 첫 회원 등록부터 막힌다", async () => {
    await setQaPlanLimits({ maxMembers: 0 });
    await expect(addMemberToCenter(centerId, managerB.profileId)).rejects.toThrow(/회원.*최대.*0명/);
  });

  it("제한 1이면 1명까지 성공하고 2번째부터 막힌다", async () => {
    await setQaPlanLimits({ maxMembers: 1 });
    await addMemberToCenter(centerId, managerB.profileId);
    await expect(addMemberToCenter(centerId, userA.profileId)).rejects.toThrow(/회원.*최대.*1명/);
  });

  it("무제한(null)이면 막히지 않는다", async () => {
    await setQaPlanLimits({ maxMembers: null });
    await addMemberToCenter(centerId, userA.profileId); // 위 테스트에서 막혔던 등록이 이번엔 성공
  });
});

describe("판매 상품 종류 수 제한 (판매중인 것만 카운트)", () => {
  it("제한 0이면 첫 상품 등록부터 막힌다", async () => {
    await setQaPlanLimits({ maxProducts: 0 });
    await expect(createProduct(centerId, "테스트상품A", 10000, 5)).rejects.toThrow(/상품.*최대.*0종/);
  });

  it("제한 1이면 1개까지 성공하고 2번째부터 막힌다", async () => {
    await setQaPlanLimits({ maxProducts: 1 });
    await createProduct(centerId, "테스트상품B", 10000, 5);
    await expect(createProduct(centerId, "테스트상품C", 10000, 5)).rejects.toThrow(/상품.*최대.*1종/);
  });

  it("비활성화(판매중지)한 상품은 카운트에서 빠져 새 상품을 등록할 수 있다", async () => {
    const admin = getFixtureAdminClient();
    const { error: deactivateErr } = await admin
      .from("products").update({ is_active: false }).eq("center_id", centerId).eq("name", "테스트상품B");
    expect(deactivateErr).toBeNull();

    await createProduct(centerId, "테스트상품D", 10000, 5); // 제한은 여전히 1이지만 활성 상품은 0개였으므로 성공
  });
});

describe("기본 플랜 지정 RPC (set_default_subscription_plan)", () => {
  it("플랫폼 운영자가 아니면 거부된다", async () => {
    await asManagerA();
    const { error } = await supabase.rpc("set_default_subscription_plan", { p_plan_id: qaPlanId });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/운영자만/);
  });

  it("플랫폼 운영자면 성공하고, 정확히 하나의 플랜만 기본으로 남는다", async () => {
    const admin = getFixtureAdminClient();
    // 임시로 managerA를 운영자로 승격(테스트 종료 즉시 원복 — sec009-batch-a2-rls.test.ts와 동일 패턴)
    await admin.from("accounts").update({ is_platform_admin: true }).eq("id", managerA.accountId);
    try {
      await asManagerA(); // 세션 role claim 갱신을 위해 재로그인
      const { error } = await supabase.rpc("set_default_subscription_plan", { p_plan_id: qaPlanId });
      expect(error).toBeNull();

      const { data: defaults } = await admin.from("subscription_plans").select("id").eq("is_default", true);
      expect(defaults).toHaveLength(1);
      expect(defaults![0].id).toBe(qaPlanId);
    } finally {
      // 전역 기본 플랜을 원래대로 되돌린 뒤(다른 세션이 그 사이 센터를 만들면 QA 플랜이
      // 배정될 위험을 최소화하기 위해 try 블록 안에서 최대한 빨리) 운영자 권한도 원복
      await admin.from("subscription_plans").update({ is_default: false }).eq("id", qaPlanId);
      await admin.from("subscription_plans").update({ is_default: true }).eq("id", defaultPlanId);
      await admin.from("accounts").update({ is_platform_admin: false }).eq("id", managerA.accountId);
      await asManagerA();
    }
  });
});

describe("사용 중인 플랜은 삭제가 막힌다 (FK 제약)", () => {
  it("center_subscriptions가 참조 중인 플랜을 지우면 거부된다", async () => {
    const admin = getFixtureAdminClient();
    const { error } = await admin.from("subscription_plans").delete().eq("id", qaPlanId);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });
});
