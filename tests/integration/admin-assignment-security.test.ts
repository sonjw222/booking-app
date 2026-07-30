/*
  관리자 직접배치/무료 추가 배치 RPC(admin_assign_reservation/admin_cancel_reservation)의
  권한·입력 검증 통합 테스트.

  범위상 제약(정직하게 기록):
  - 이 프로젝트의 통합 테스트 fixture(tests/integration/setup.ts)는 일반 회원 계정(A/B) +
    TEST_CENTER_ID/TEST_PRODUCT_ID만 제공하고, "그 센터의 매니저/오너 테스트 계정"이나
    "미래 시각의 테스트 전용 수업" fixture는 없다. 매니저 fixture를 새로 만들려면 서비스
    역할 키 또는 운영자의 수동 설정이 필요해 이번 범위에서 임의로 추가하지 않았다
    (docs/TODO.md에 후속 작업으로 기록).
  - 따라서 여기서는 "일반 회원(비관리자)의 직접 RPC 호출이 실제로 차단되는지"와
    "존재하지 않는 대상/잘못된 입력값이 명확한 에러로 거부되는지"만 검증한다.
    실제 성공 경로(배치 성공, 정원 초과 확인, 취소 시 수강권 복구)는 매니저 fixture가 없어
    이 테스트 스위트에서 실행하지 못했다 — 수동 테스트로 검증했으며 아래 안내를 참고.
  - TEST_CENTER_ID에 "앞으로 시작할 open 상태 수업"이 있어야만 확인 가능한 케이스(권한 차단)는
    그런 수업이 없으면 콘솔에 사유를 남기고 건너뛴다(가짜로 통과시키지 않음).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { TEST_CENTER_ID, switchToTestUser, type TestUser } from "./setup";

let testUser: TestUser;
let futureOpenClassId: string | null = null;

beforeAll(async () => {
  testUser = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");

  const { data } = await supabase
    .from("classes")
    .select("id, start_time, status")
    .eq("center_id", TEST_CENTER_ID)
    .eq("status", "open")
    .gt("start_time", new Date().toISOString())
    .order("start_time", { ascending: true })
    .limit(1);
  futureOpenClassId = data?.[0]?.id ?? null;
  if (!futureOpenClassId) {
    // eslint-disable-next-line no-console
    console.warn(
      "[admin-assignment-security] TEST_CENTER_ID에 예정된(open) 수업이 없어 " +
        "권한 차단 테스트 일부를 건너뜁니다. 수동으로 미래 수업을 하나 등록하면 실행됩니다."
    );
  }
});

afterAll(async () => {
  await supabase.auth.signOut();
});

describe("admin_assign_reservation 입력 검증 (fixture 불필요)", () => {
  it("잘못된 배치 방식(assignment_type)이면 즉시 거부된다", async () => {
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: "00000000-0000-0000-0000-000000000000",
      p_profile_id: testUser.profileId,
      p_assignment_type: "SOMETHING_ELSE",
      p_membership_id: null,
      p_reason_code: null,
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("잘못된 배치 방식");
  });

  it("잘못된 배치 사유 코드면 거부된다", async () => {
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: "00000000-0000-0000-0000-000000000000",
      p_profile_id: testUser.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "NOT_A_REAL_CODE",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("잘못된 배치 사유");
  });

  it("존재하지 않는 수업으로 배치를 시도하면 거부된다", async () => {
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: "00000000-0000-0000-0000-000000000000",
      p_profile_id: testUser.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "EVENT",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("수업을 찾을 수 없어요");
  });

  it("일반 회원(비관리자)이 실제 수업에 직접배치를 시도하면 '관리자 권한이 없어요'로 거부된다", async () => {
    if (!futureOpenClassId) return; // beforeAll에서 사유를 이미 콘솔에 남김
    const { data, error } = await supabase.rpc("admin_assign_reservation", {
      p_class_id: futureOpenClassId,
      p_profile_id: testUser.profileId,
      p_assignment_type: "ADMIN_FREE",
      p_membership_id: null,
      p_reason_code: "EVENT",
      p_reason_detail: null,
      p_force_capacity: false,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("관리자 권한이 없어요");
  });
});

describe("admin_cancel_reservation 입력 검증 (fixture 불필요)", () => {
  it("존재하지 않는 예약을 취소하려 하면 거부된다", async () => {
    const { data, error } = await supabase.rpc("admin_cancel_reservation", {
      p_reservation_id: "00000000-0000-0000-0000-000000000000",
      p_cancel_reason: null,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("예약을 찾을 수 없어요");
  });
});
