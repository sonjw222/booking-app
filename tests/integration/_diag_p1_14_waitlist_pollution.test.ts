/*
  임시 진단 전용 파일(P1-14) — READ-ONLY, DELETE/UPDATE 없음.
  attendance-policy.test.ts가 3회 연속 "이번 주 대기예약 가능 횟수(10회)를 초과했어요"로
  실패하는 원인을 규명하기 위해, memberB의 현재 waitlisted reservations를 전부 실측 조회한다.
  진단이 끝나면 이 파일과 CI의 diag 잡을 전부 제거한다(코드 수정 없이 조회만).
*/
import { describe, it } from "vitest";
import {
  switchToTestUser,
  signOutTestSession,
  getFixtureAdminClient,
  getOrCreateOwnedTestCenter,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MEMBER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };
const MEMBER_B = { email: "TEST_USER_B_EMAIL", password: "TEST_USER_B_PASSWORD" };

describe("P1-14 진단(read-only)", () => {
  it("memberB의 waitlisted reservations 전수 조사", async () => {
    const managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const centerAId = await getOrCreateOwnedTestCenter(managerA);
    const memberA = await switchToTestUser(MEMBER_A.email, MEMBER_A.password);
    const memberB = await switchToTestUser(MEMBER_B.email, MEMBER_B.password);
    await signOutTestSession();

    const admin = getFixtureAdminClient();

    console.log(`=== P1-14 DIAG: centerAId=${centerAId} memberB.profileId=${memberB.profileId} memberA.profileId=${memberA.profileId} managerA.profileId=${managerA.profileId} ===`);

    // 1) memberB의 waitlisted reservations — 센터 무관 전수(어느 센터에 걸쳐 있는지 확인)
    const { data: allWaitB, error: e1 } = await admin
      .from("reservations")
      .select("id, profile_id, class_id, status, created_at, membership_id, classes(id, title, start_time, center_id)")
      .eq("profile_id", memberB.profileId)
      .eq("status", "waitlisted")
      .order("created_at", { ascending: true });
    console.log(`=== P1-14 DIAG: memberB waitlisted 전체(센터 무관) 건수=${allWaitB?.length ?? "ERROR"} error=${e1?.message ?? "none"} ===`);
    console.log(`=== P1-14 DIAG: memberB waitlisted 전체 상세=${JSON.stringify(allWaitB, null, 2)} ===`);

    // 2) centerA로 좁힌 것 (RPC가 실제로 세는 범위와 동일 — profile_id + center_id + status)
    const centerAWaitB = (allWaitB ?? []).filter((r: any) => r.classes?.center_id === centerAId);
    console.log(`=== P1-14 DIAG: memberB waitlisted centerA만 건수=${centerAWaitB.length} (한도 10) ===`);

    // 3) 비교군: memberA/managerA의 waitlisted도 확인(같은 문제가 다른 계정에도 있는지)
    const { data: allWaitA } = await admin
      .from("reservations")
      .select("id, profile_id, class_id, status, created_at, classes(title, start_time, center_id)")
      .eq("profile_id", memberA.profileId)
      .eq("status", "waitlisted");
    console.log(`=== P1-14 DIAG: memberA waitlisted 전체 건수=${allWaitA?.length ?? "ERROR"} 상세=${JSON.stringify(allWaitA, null, 2)} ===`);

    // 4) admin_action_logs가 이 reservation_id들 중 하나라도 참조하는지(FK 삭제 실패 가설 검증)
    const resIds = (allWaitB ?? []).map((r: any) => r.id);
    if (resIds.length > 0) {
      const { data: logs, error: logErr } = await admin
        .from("admin_action_logs")
        .select("id, reservation_id, action_type")
        .in("reservation_id", resIds);
      console.log(`=== P1-14 DIAG: admin_action_logs가 참조하는 memberB waitlisted 건수=${logs?.length ?? "ERROR(" + logErr?.message + ")"} 상세=${JSON.stringify(logs)} ===`);
    } else {
      console.log(`=== P1-14 DIAG: memberB waitlisted reservation이 0건이라 admin_action_logs 참조 확인 생략 ===`);
    }

    // 5) 이 reservation들의 class_id가 classes 테이블에 정말 살아있는지(고아 reservation인지)
    //    — classes(...)  임베디드 select가 null로 나오면 class 자체가 없거나 FK가 깨진 것.
    const orphaned = (allWaitB ?? []).filter((r: any) => !r.classes);
    console.log(`=== P1-14 DIAG: class join이 안 되는(고아 가능성) memberB waitlisted 건수=${orphaned.length} 상세=${JSON.stringify(orphaned)} ===`);
  }, 60000);
});
