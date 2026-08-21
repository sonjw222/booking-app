/*
  P1-5/P1-5b 자동 QA: 매니저 화면의 "버튼 유무" 게이팅이 실제로 의존하는 두 레이어를
  라이브 Supabase로 검증한다.

    1) fetchMyEffectivePermissionKeys() — 모든 화면의 `{canX && <button>}`가 최종적으로
       읽는 값(lib/roles.ts). canSeeManagerMenu()는 `isOwner || myPerms?.has(key)`뿐인
       순수 함수라 여기 검증만으로 버튼 노출 로직 전체를 사실상 커버한다.
    2) P1-5b에서 새로 만든 classes own/other × group/private RPC
       (create_class_safe/update_class_safe/delete_class_safe, set_class_trainers_safe) —
       이번 배치에서 가장 크고 가장 최근에 바뀐 코드라, 서버 거부/허용이 의도대로
       동작하는지 실제 RPC 호출로 검증한다.
    3) Bucket 2 RLS(products/rooms) — has_permission() 기반으로 새로 좁힌 정책이
       실제로 서버에서 거부/허용하는지 대표로 하나씩 실제 insert 시도로 검증한다.

  TEST_MANAGER_A = centerA 오너(own/other 구분 검증용 "다른 담당 강사" 역할도 겸함).
  TEST_MANAGER_B = centerA에 초대되어 권한을 실행 중에 계속 바꿔가며 테스트하는 스태프.

  필요한 환경변수(.env.test.local, 없으면 requireEnv가 안내):
    TEST_MANAGER_A_EMAIL/PASSWORD, TEST_MANAGER_B_EMAIL/PASSWORD
    (acl-003-permission-read.test.ts와 공유 — 이 파일 전용 계정 없음)
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, type TestUser } from "./setup";
import {
  createRole, fetchRoles, inviteStaff, removeStaff, deleteRole, saveRolePermissions,
  fetchMyEffectivePermissionKeys,
} from "../../lib/roles";
import { createProduct, deleteProduct } from "../../lib/passes";
import { addRoom, deleteRoom } from "../../lib/rooms";
import { createClass, updateClass, deleteClass, setClassTrainers } from "../../lib/classes";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

const ROLE_NAME = "P1-5b QA 게이팅 역할";
const QA_PRODUCT_NAME = "P1-5b QA 임시상품";
const QA_ROOM_NAME = "P1-5b QA 임시룸";

let managerA: TestUser;
let managerB: TestUser;
let centerAId: string;
let roleId: string;
let staffManagerCenterId: string;

// 이번 실행이 실제로 "새로 만든" 것만 기록 — acl-003-permission-read.test.ts와 같은 관례.
let createdRoleId: string | null = null;
let createdStaffManagerCenterId: string | null = null;
const createdClassIds: string[] = [];
let createdProductId: string | null = null;
let createdRoomId: string | null = null;

function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DATE = tomorrowStr();

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);

  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const roles = await fetchRoles(centerAId);
  let role = roles.find((r) => r.name === ROLE_NAME);
  if (!role) {
    await createRole(centerAId, ROLE_NAME);
    const refreshed = await fetchRoles(centerAId);
    role = refreshed.find((r) => r.name === ROLE_NAME);
    if (role) createdRoleId = role.id;
  }
  if (!role) throw new Error("QA 역할 생성에 실패했어요");
  roleId = role.id;

  // 이전 실행의 잔여 권한이 있을 수 있으니 항상 0개로 리셋하고 시작한다.
  await saveRolePermissions(roleId, []);

  try {
    await inviteStaff(centerAId, managerB.accountId, roleId);
  } catch (e: any) {
    if (!e.message.includes("이미 이 센터의 스태프")) throw e;
  }

  const { data: mcRow, error: mcErr } = await supabase
    .from("manager_centers")
    .select("id")
    .eq("center_id", centerAId)
    .eq("account_id", managerB.accountId)
    .single();
  if (mcErr || !mcRow) throw new Error("스태프 행을 찾지 못했어요: " + mcErr?.message);
  staffManagerCenterId = (mcRow as any).id;
  // 방금 새로 초대된 경우에만 afterAll에서 제외(초대) 대상으로 기록 — 이미 있었다면 보존.
  createdStaffManagerCenterId = staffManagerCenterId;
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];

  for (const id of createdClassIds) {
    try { await deleteClass(id); } catch (e: any) { errors.push(`class 정리 실패(${id}): ${e.message}`); }
  }
  if (createdProductId) {
    try { await deleteProduct(createdProductId); } catch (e: any) { errors.push(`product 정리 실패: ${e.message}`); }
  }
  if (createdRoomId) {
    try { await deleteRoom(createdRoomId); } catch (e: any) { errors.push(`room 정리 실패: ${e.message}`); }
  }
  try { await saveRolePermissions(roleId, []); } catch (e: any) { errors.push(`권한 리셋 실패: ${e.message}`); }
  if (createdStaffManagerCenterId) {
    try { await removeStaff(createdStaffManagerCenterId); } catch (e: any) { errors.push(`스태프 정리 실패: ${e.message}`); }
  }
  if (createdRoleId) {
    try { await deleteRole(createdRoleId); } catch (e: any) { errors.push(`역할 정리 실패: ${e.message}`); }
  }

  if (errors.length > 0) {
    throw new Error(`P1-5b QA fixture cleanup 실패 — 공유 개발 DB에 잔여 데이터가 남았을 수 있습니다:\n${errors.join("\n")}`);
  }
}, 60000);

describe("fetchMyEffectivePermissionKeys — 모든 버튼 게이팅이 최종적으로 읽는 집합", () => {
  it("권한이 하나도 없는 역할은 빈 집합을 반환한다(= 모든 버튼이 숨겨져야 함)", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const perms = await fetchMyEffectivePermissionKeys(staffManagerCenterId, roleId);
    expect(perms.size).toBe(0);
  });

  it("역할에 키를 부여하면 정확히 그 집합을 반환하고, 부여 안 한 키는 없다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, ["facility.room", "pass.create", "schedule.own.group.create"]);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const perms = await fetchMyEffectivePermissionKeys(staffManagerCenterId, roleId);
    expect(perms.has("facility.room")).toBe(true);
    expect(perms.has("pass.create")).toBe(true);
    expect(perms.has("schedule.own.group.create")).toBe(true);
    expect(perms.has("schedule.own.group.update")).toBe(false);
    expect(perms.has("schedule.other.group.update")).toBe(false);
  });
});

describe("Bucket 2 RLS 실제 서버 거부/허용 — products/rooms", () => {
  it("pass.create 없으면 상품 등록이 서버에서 거부된다(버튼이 숨겨져야 하는 상태와 일치)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, []);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    await expect(createProduct(centerAId, QA_PRODUCT_NAME, 10000, 5)).rejects.toThrow();
  });

  it("pass.create를 부여하면 상품 등록이 허용된다(버튼이 보여야 하는 상태와 일치)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, ["pass.create"]);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    await createProduct(centerAId, QA_PRODUCT_NAME, 10000, 5);
    const { data } = await supabase
      .from("products").select("id")
      .eq("center_id", centerAId).eq("name", QA_PRODUCT_NAME)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    createdProductId = (data as any)?.id ?? null;
    expect(createdProductId).toBeTruthy();
  });

  it("facility.room 없으면 룸 등록이 서버에서 거부된다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, []);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    await expect(
      addRoom(centerAId, { name: QA_ROOM_NAME, memo: "", address: "", latitude: null, longitude: null })
    ).rejects.toThrow();
  });

  it("facility.room을 부여하면 룸 등록이 허용된다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, ["facility.room"]);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    await addRoom(centerAId, { name: QA_ROOM_NAME, memo: "", address: "", latitude: null, longitude: null });
    const { data } = await supabase
      .from("rooms").select("id")
      .eq("center_id", centerAId).eq("name", QA_ROOM_NAME)
      .order("id", { ascending: false }).limit(1).maybeSingle();
    createdRoomId = (data as any)?.id ?? null;
    expect(createdRoomId).toBeTruthy();
  });
});

describe("P1-5b classes own/other — 새 RPC(create/update/delete_class_safe) 실제 서버 거부/허용", () => {
  let ownClassId: string;
  let otherClassId: string;

  it("schedule.own.group.create 없으면 수업 생성이 거부된다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, []);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    await expect(createClass(centerAId, {
      title: "QA own 테스트 수업", date: DATE, start: "10:00", end: "11:00",
      capacity: 5, allowGoods: true,
    })).rejects.toThrow();
  });

  it("schedule.own.group.create를 부여하면 수업 생성이 허용된다(담당 강사 미지정 → own)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, ["schedule.own.group.create"]);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    ownClassId = await createClass(centerAId, {
      title: "QA own 테스트 수업", date: DATE, start: "10:00", end: "11:00",
      capacity: 5, allowGoods: true,
    });
    createdClassIds.push(ownClassId);
    expect(ownClassId).toBeTruthy();
  });

  it("담당 강사가 없는(own) 수업은 own.update만으로 수정할 수 있다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, ["schedule.own.group.create", "schedule.own.group.update"]);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    await updateClass(ownClassId, {
      title: "QA own 테스트 수업(수정됨)", date: DATE, start: "10:00", end: "11:00",
      capacity: 6, allowGoods: true,
    });
  });

  it("다른 사람(managerA)이 담당인 수업은 own.update만으로는 수정할 수 없다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    otherClassId = await createClass(centerAId, {
      title: "QA other 테스트 수업", date: DATE, start: "14:00", end: "15:00",
      capacity: 5, allowGoods: true,
    });
    createdClassIds.push(otherClassId);
    await setClassTrainers(otherClassId, [managerA.accountId]);

    // managerB는 own.update만 있고 other.update는 없는 상태(직전 테스트에서 이어짐)
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    await expect(updateClass(otherClassId, {
      title: "QA other 테스트 수업(시도)", date: DATE, start: "14:00", end: "15:00",
      capacity: 6, allowGoods: true,
    })).rejects.toThrow();
  });

  it("schedule.other.group.update를 부여하면 다른 사람 담당 수업도 수정할 수 있다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, [
      "schedule.own.group.create", "schedule.own.group.update", "schedule.other.group.update",
    ]);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    await updateClass(otherClassId, {
      title: "QA other 테스트 수업(수정됨)", date: DATE, start: "14:00", end: "15:00",
      capacity: 6, allowGoods: true,
    });
  });

  it("삭제도 own/other가 분리 적용된다 — own은 own.delete만으로, other는 other.delete까지 필요", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, ["schedule.own.group.delete"]);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    await deleteClass(ownClassId);
    createdClassIds.splice(createdClassIds.indexOf(ownClassId), 1);

    // other(managerA 담당) 수업은 own.delete만으로는 거부돼야 한다.
    await expect(deleteClass(otherClassId)).rejects.toThrow();

    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await saveRolePermissions(roleId, ["schedule.own.group.delete", "schedule.other.group.delete"]);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    await deleteClass(otherClassId);
    createdClassIds.splice(createdClassIds.indexOf(otherClassId), 1);
  });
});
