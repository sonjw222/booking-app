/*
  RES-002(#42): fetchMonthData()의 myMems 쿼리가 classRows와 달리 .range() 페이지네이션이
  없어 PostgREST 기본 응답 행 수 제한(1000)에 걸릴 수 있던 문제 — 회귀 테스트.

  기존에 이미 고쳐진 형제 버그(classes-row-limit-regression.test.ts)와 원인이 동일하다:
  fetchMonthData()는 "내가 수강권을 보유한 센터 집합(myMembershipCenters)"을 먼저 구해서
  그 센터들의 classes만 조회하는데, 정작 그 집합을 만드는 memberships 쿼리 자체는 1000행
  cap 없이 통으로 가져왔다. 한 계정이 여러 프로필로 1000개 넘는 memberships를 갖고 있으면
  (실측: 공유 테스트 계정에 수백~수천 건 누적된 사례가 이미 여러 번 발견됨), 1000번째 이후
  행이 잘려 그 안에만 있던 센터가 myMembershipCenters에서 통째로 빠지고, 그 센터의 수업이
  전부 회원 화면(달력)에서 안 보이게 된다.

  이 테스트는 classes-row-limit-regression.test.ts와 동일한 전략을 쓴다 — "고친 코드가
  실제로 전부 가져오는지"를 직접 fetchMonthData()를 호출해 검증한다(옛(미수정) 코드를 이
  테스트에서 다시 살려 재현하지는 않는다 — 이미 고쳐졌고, 고친 함수 자체를 검증하는 것이
  목적). 동시에 "가족 profile 간 membership 공유 구조"가 페이지네이션 추가로 깨지지
  않는지도 같이 확인한다 — 문제의 target membership을 계정의 대표 프로필이 아니라 추가
  (자녀) 프로필에 둔다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { fetchMonthData } from "../../lib/reservations";
import { getKstMonthUtcRange } from "../../lib/kst";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

// 다른 테스트(classes-row-limit-regression.test.ts는 2031-07)와 겹치지 않는 전용 월.
const YEAR = 2031;
const MONTH = 8;
const FILLER_MARKER = "MYMEMS-FIX-FILLER";
const TARGET_MARKER = "MYMEMS-FIX-TARGET";
const TARGET_CLASS_TITLE = "MYMEMS-FIX-TARGET-CLASS";
// PostgREST 기본 응답 행 수 제한(1000)을 확실히 넘기는 필러 개수.
const FILLER_COUNT = 1005;

let managerA: TestUser;
let managerB: TestUser;
let centerAId: string;
let centerBId: string;
let childProfileId: string;
let targetClassId: string;

async function cleanupFixtureRows() {
  const admin = getFixtureAdminClient();
  await admin.from("memberships").delete().eq("center_id", centerAId).eq("product_name", FILLER_MARKER);
  await admin.from("memberships").delete().eq("center_id", centerBId).eq("product_name", TARGET_MARKER);
  if (targetClassId) {
    await admin.from("reservations").delete().eq("class_id", targetClassId);
    await admin.from("classes").delete().eq("id", targetClassId);
  } else {
    await admin.from("classes").delete().eq("center_id", centerBId).eq("title", TARGET_CLASS_TITLE);
  }
  if (childProfileId) await admin.from("profiles").delete().eq("id", childProfileId);
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  centerBId = await getOrCreateOwnedTestCenter(managerB);

  const admin = getFixtureAdminClient();

  await cleanupFixtureRows(); // 이전 실행이 중간에 실패해 남긴 행이 있으면 먼저 정리

  // managerA 계정에 "자녀 프로필"을 하나 추가 — target membership을 대표 프로필이 아니라
  // 이 프로필에 둬서, 페이지네이션 수정이 가족(계정 내 여러 프로필) 공유 구조를 깨지
  // 않는지 함께 검증한다.
  const { data: childProfile, error: childErr } = await admin
    .from("profiles")
    .insert({ account_id: managerA.accountId, name: "RES-002 자녀 프로필", is_primary: false })
    .select("id").single();
  if (childErr || !childProfile) throw new Error(`자녀 프로필 생성 실패: ${childErr?.message ?? "no data"}`);
  childProfileId = childProfile.id;

  // centerA에 필러 memberships 1005건 — managerA의 대표 프로필 소유. 실제 회원 세션은 자기
  // memberships를 직접 insert할 수 없어(RLS) admin(service_role)으로 만든다
  // (class-allowed-products-enforcement.test.ts와 동일 관례).
  const fillerRows = Array.from({ length: FILLER_COUNT }, (_, i) => ({
    profile_id: managerA.profileId, center_id: centerAId,
    product_name: FILLER_MARKER, pass_type: "count",
    total_count: 5, remaining_count: 5,
    expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    status: "active",
  }));
  const { error: fillerErr } = await admin.from("memberships").insert(fillerRows);
  if (fillerErr) throw new Error(`필러 membership 생성 실패: ${fillerErr.message}`);

  // centerB에 "target" membership 정확히 1건 — 자녀 프로필 소유. 1005건의 필러 뒤에
  // 삽입되므로, .range() 페이지네이션 없이는 기본 PostgREST 응답(첫 1000행)에서 잘려나갈
  // 가능성이 있는 위치다.
  const { error: targetErr } = await admin.from("memberships").insert({
    profile_id: childProfileId, center_id: centerBId,
    product_name: TARGET_MARKER, pass_type: "count",
    total_count: 5, remaining_count: 5,
    expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    status: "active",
  });
  if (targetErr) throw new Error(`target membership 생성 실패: ${targetErr.message}`);

  // centerB에 대상 월(YEAR-MONTH) 안의 수업을 하나 만든다 — fetchMonthData가 실제로 이
  // 센터의 수업을 가져오는지 확인할 대상.
  const { startUtcIso } = getKstMonthUtcRange(YEAR, MONTH);
  const classStart = new Date(new Date(startUtcIso).getTime() + 5 * 24 * 3600 * 1000); // 월초에서 5일 뒤
  const classEnd = new Date(classStart.getTime() + 60 * 60 * 1000);
  await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  const { data: cls, error: clsErr } = await supabase
    .from("classes")
    .insert({
      center_id: centerBId, title: TARGET_CLASS_TITLE,
      start_time: classStart.toISOString(), end_time: classEnd.toISOString(), capacity: 8,
    })
    .select("id").single();
  if (clsErr || !cls) throw new Error(`target class 생성 실패: ${clsErr?.message ?? "no data"}`);
  targetClassId = cls.id;
}, 60000);

afterAll(async () => {
  await cleanupFixtureRows();
}, 30000);

describe("RES-002 회귀: fetchMonthData()의 myMems가 1000행 cap과 무관하게 정확하다", () => {
  it("1005개 필러 membership(centerA) 뒤에 있는 target membership(centerB, 자녀 프로필)의 센터가 정확히 포함된다", async () => {
    // ⚠ beforeAll의 마지막 세션은 managerB(centerB에 target class를 만들기 위해 전환한
    // 것)로 남아있다 — fetchMonthData()는 accountId를 파라미터로 받지만 내부 쿼리는
    // 전부 RLS가 적용된 supabase 싱글턴을 그대로 쓰므로, 실제 인증 세션이 managerB인 채로
    // managerA.accountId를 조회하면 RLS가 막아 전부 빈 배열이 돌아온다(실측 확인:
    // totalCentersReturned=0). classes-row-limit-regression.test.ts와 동일하게 호출 직전
    // managerA로 명시 전환해야 한다.
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const { classes, centers } = await fetchMonthData(YEAR, MONTH, managerA.accountId);

    const centerIds = new Set(centers.map((c) => c.id));
    const classTitles = new Set(classes.map((c) => c.title));

    const report = {
      totalCentersReturned: centers.length,
      hasCenterB: centerIds.has(centerBId),
      hasTargetClass: classTitles.has(TARGET_CLASS_TITLE),
      hasCenterA: centerIds.has(centerAId),
    };

    // 핵심 회귀 검증: 1005개 필러 뒤에 있는 centerB(자녀 프로필의 단일 membership)가
    // myMembershipCenters에서 누락되지 않고, 그 센터의 수업이 실제로 반환된다.
    expect(report.hasCenterB, JSON.stringify(report)).toBe(true);
    expect(report.hasTargetClass, JSON.stringify(report)).toBe(true);
    // ⚠ hasCenterA는 대조군으로 넣었지만 실제로는 항상 false다 — centers/classes는
    // fetchMonthData()가 "그 달에 실제 class가 있는 센터"만 담아 반환하는데(centerMap이
    // classRows를 순회해 채워짐), 이 테스트는 centerA에 membership만 1005건 만들었을 뿐
    // class는 하나도 만들지 않았다(실측 확인: totalCentersReturned=1, hasCenterA=false —
    // 앱 버그 아니라 이 테스트의 잘못된 가정이었음). centerA가 myMembershipCenters
    // 집합에는 포함되는지는 이미 그 전제 위에서만 성립하는 centerB/target 검증이 통과한
    // 것으로 충분히 증명되므로 별도 assert를 만들지 않는다.
  }, 30000);
});
