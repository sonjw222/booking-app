/*
  임시 진단 전용 파일(P1-14 사후 검증) — READ-ONLY, DELETE/UPDATE 없음.
  사용자가 cleanup_p1_14_waitlisted_test_pollution_draft_proposed.sql을 Supabase SQL
  Editor에서 실행 완료했다고 보고함(C-1: memberB_centerA_waitlisted_remaining=0). 이 앱의
  자체 진단으로 (1) 그 결과를 독립적으로 재확인하고, (2) 의도치 않은 과잉 삭제가 없었는지
  주변 데이터로 교차 확인한다. 진단이 끝나면 이 파일은 삭제한다.
*/
import { describe, it } from "vitest";
import { getFixtureAdminClient } from "./setup";

const MEMBER_B_PROFILE_ID = "f2c9749a-b282-433b-8b60-a982b81a53f3";
const MEMBER_A_PROFILE_ID = "bf0939f6-d676-43bd-a164-c021ad623063";
const CENTER_A_ID = "3937eb89-3803-43e9-9a29-e893f779df1a";

describe("P1-14 사후 검증(read-only)", () => {
  it("cleanup 결과 재확인 + 과잉 삭제 여부 교차 확인", async () => {
    const admin = getFixtureAdminClient();

    // 1) C-1 독립 재확인: memberB의 centerA waitlisted 예약 = 0이어야 함
    const { count: memberBWaitlisted, error: e1 } = await admin
      .from("reservations")
      .select("id, classes!inner(center_id)", { count: "exact", head: true })
      .eq("profile_id", MEMBER_B_PROFILE_ID)
      .eq("status", "waitlisted")
      .eq("classes.center_id", CENTER_A_ID);
    console.log(`=== P1-14 POST-VERIFY: memberB centerA waitlisted 재확인 count=${memberBWaitlisted} error=${e1?.message ?? "none"} ===`);

    // 2) memberA의 waitlisted는 원래 0건이었다 — 과잉 삭제로 오히려 줄어들 수 없는 값이니
    //    여전히 0(또는 그 이상, 다른 테스트가 만들었을 수 있음)인지만 확인(음수/에러 없나)
    const { count: memberAWaitlisted, error: e2 } = await admin
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", MEMBER_A_PROFILE_ID)
      .eq("status", "waitlisted");
    console.log(`=== P1-14 POST-VERIFY: memberA 전체 waitlisted count=${memberAWaitlisted} error=${e2?.message ?? "none"} ===`);

    // 3) "P3 출결-*" 5개 title 전체의 reservations 건수(status 무관) — cleanup은 딱 하나의
    //    title("P3 출결-대기거부")의 waitlisted 건만 지웠어야 하므로, 다른 4개 title의
    //    reservations는 cleanup 전후로 개수가 그대로여야 한다(다른 파일 재실행으로 새로
    //    생겼을 수는 있어도 "이상하게 줄어듦"은 없어야 함).
    const titles = ["P3 출결-취소최종", "P3 출결-대기거부", "P3 출결-대기취소", "P3 출결-타센터차단", "P3 출결-프라이빗"];
    for (const title of titles) {
      const { data: classes } = await admin.from("classes").select("id").eq("center_id", CENTER_A_ID).eq("title", title);
      const classIds = (classes ?? []).map((c: any) => c.id);
      let resCount = 0;
      if (classIds.length > 0) {
        const { count } = await admin.from("reservations").select("id", { count: "exact", head: true }).in("class_id", classIds);
        resCount = count ?? 0;
      }
      console.log(`=== P1-14 POST-VERIFY: title="${title}" classes=${classIds.length}건 reservations=${resCount}건 ===`);
    }

    // 4) "P3 출결-대기거부" class 자체 잔존 여부(예상: 남아있음 — memberA confirmed 예약이
    //    아직 있어서 class delete 조건에 안 걸림)
    const { data: staleClasses } = await admin
      .from("classes").select("id, start_time").eq("center_id", CENTER_A_ID).eq("title", "P3 출결-대기거부");
    console.log(`=== P1-14 POST-VERIFY: "P3 출결-대기거부" class 잔존 건수=${staleClasses?.length ?? 0} ===`);

    // 5) centerA 전체 reservations 총 건수(참고용 — 과잉 삭제로 급격히 줄지 않았는지 육안 확인)
    const { count: centerATotalRes } = await admin
      .from("reservations")
      .select("id, classes!inner(center_id)", { count: "exact", head: true })
      .eq("classes.center_id", CENTER_A_ID);
    console.log(`=== P1-14 POST-VERIFY: centerA 전체 reservations 총 건수=${centerATotalRes} ===`);
  }, 60000);
});
