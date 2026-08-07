/*
  RES-001 (Track C-5) 회귀 테스트 — 예약 생성 후 10분 이내 무료 취소 예외.

  ⚠️ 이 파일은 다음 SQL이 모두 적용되기 전에는 의도적으로 FAIL해야 합니다(순서대로):
    1. fix_reservation_cancel_source_column_draft_proposed.sql
    2. fix_reservation_cancel_grace_period_draft_proposed.sql
  적용 후 green이 되어야 정상입니다.

  created_at 조작 방법: reservations에는 회원 본인이 자기 예약 행을 update할 수 있는 RLS
  정책("본인 예약 메모 수정", reservation_functions.sql)이 있고, 이 정책은 행 소유권만
  검사할 뿐 컬럼을 제한하지 않는다 — 그래서 admin/service-role 없이도 로그인된 본인 세션으로
  직접 created_at을 과거로 되돌려 "N분 전에 예약했다"를 재현할 수 있다(실제 대기 없이 테스트).

  "수업 시작 이후 취소 불가"만은 시작 시각 자체를 흉내낼 수 없어 몇 초짜리 실제 대기를 쓴다
  (짧고 결정적).

  "정확히 10분 경계"는 이 파일의 백데이트 방식으로 실제로 검증한다(now() > deadline이 엄격
  부등호라 정확히 10분 지점은 포함됨).
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  createKstSameDayFutureClass,
  createTestMembership,
  fetchMembershipRemaining,
  cleanupTestClass,
  type TestUser,
} from "./setup";
import { fetchSettings, saveSettings, type CenterSettings } from "../../lib/settings";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

let managerA: TestUser;
let centerAId: string;
let defaultSettings: CenterSettings;
const createdClassIds: string[] = [];

async function backdateCreatedAt(reservationId: string, minutesAgo: number) {
  const ts = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  const { error } = await supabase.from("reservations").update({ created_at: ts }).eq("id", reservationId);
  if (error) throw new Error(`created_at 백데이트 실패: ${error.message}`);
}

// group_cancel_days_before=0일 때 취소마감은 "수업 날짜의 고정된 절대 시각"이다(calc_deadline()).
// "이미 지남"이 필요한 테스트는 두 가지를 시간대와 무관하게 보장해야 한다:
//   1) 수업 자체가 항상 "오늘"(KST) 날짜여야 한다 — createFutureTestClass(hoursFromNow: 2)처럼
//      고정 오프셋을 쓰면 CI가 KST 21:00~23:59 사이에 실행될 때 자정을 넘겨 "내일" 수업이 되고
//      마는 문제가 실제로 있었다(재현 확인) — createKstSameDayFutureClass로 항상 "오늘 안"으로
//      고정한다(다른 당일예약 테스트들과 동일한 기존 헬퍼, setup.ts 참고).
//   2) 마감 시각(HH:MM)도 "오늘 날짜 기준으로 이미 지났다"가 항상 성립해야 한다 — 이전에는
//      "지금-30분"을 썼는데, 자정 직후(00:00~00:29 KST)에는 그 계산이 어제 시각으로 넘어가면서
//      "수업 날짜(=오늘) + 그 시각"이 오히려 아직 안 지난 미래가 돼버리는 대칭적인 문제가 있었다.
//      "00:01"(자정 1분 후) 같은 하루 중 가장 이른 고정 시각을 쓰면, 테스트가 자정 첫 1분
//      안에 실행되는 경우만 빼고 항상 "이미 지났다"가 보장된다 — 상대 계산 자체를 없애 두
//      경계 문제를 한 번에 제거한다.
const ALWAYS_PAST_CANCEL_TIME = "00:01";

async function reserveAndGetId(classId: string): Promise<string> {
  const { data, error } = await supabase.rpc("reserve_class", { p_class_id: classId, p_profile_id: managerA.profileId });
  if (error) throw new Error(`예약 실패: ${error.message}`);
  return (data as any).reservation_id;
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  defaultSettings = await fetchSettings(centerAId);
}, 30000);

afterEach(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  await saveSettings(centerAId, defaultSettings);
});

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];
  for (const classId of createdClassIds) {
    try { await cleanupTestClass(classId, []); } catch (e: any) { errors.push(e.message); }
  }
  try { await saveSettings(centerAId, defaultSettings); } catch (e: any) { errors.push(e.message); }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("RES-001: 예약 후 10분 이내 무료 취소 예외", () => {
  it("5분 전에 예약했으면(10분 이내) 정상 취소되고 수강권이 환급된다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "RES-001 5분전", hoursFromNow: 240 });
    createdClassIds.push(cls.id);
    const mem = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const resId = await reserveAndGetId(cls.id);
    await backdateCreatedAt(resId, 5);

    const { data, error } = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(error).toBeNull();
    expect((data as any).cancelled).toBe(true);
    expect(await fetchMembershipRemaining(mem.id)).toBe(3); // 2(예약 소모) → 3(환급)
  });

  it("정확히 10분 전이면(경계값 포함) 여전히 취소 가능하다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "RES-001 정확히10분", hoursFromNow: 240 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const resId = await reserveAndGetId(cls.id);
    await backdateCreatedAt(resId, 10);

    const { error } = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(error).toBeNull();
  });

  it("10분을 초과하고 일반 취소마감도 지났으면 취소가 차단된다", async () => {
    // defaultSettings의 group_cancel_days_before가 우연히 0으로 남아있으면(다른 테스트/세션이
    // 그 상태로 복원한 경우) "당일 수업의 취소 마감은 항상 어제"라는 가정이 깨진다 — pre-existing
    // 값에 기대지 않고 취소 마감을 명시적으로 과거 절대 시각으로 저장한다(book은 예약 자체가
    // 막히지 않도록 열어둠).
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      groupCancelDaysBefore: 0, groupCancelTime: ALWAYS_PAST_CANCEL_TIME,
    });
    const cls = await createKstSameDayFutureClass(centerAId, { title: "RES-001 10분초과", preferredMinutesFromNow: 120 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const resId = await reserveAndGetId(cls.id);
    await backdateCreatedAt(resId, 11);

    const { error } = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("취소 마감시간이 지났어요");
  });

  it("수업 시작 이후에는 10분 이내였더라도(예약을 아주 늦게 했어도) 취소할 수 없다", async () => {
    // 시작 시각 자체는 흉내낼 수 없어 아주 가까운 미래(수 초 뒤)에 수업을 만들고 실제로
    // 그 시각이 지나가길 기다린다 — 결정적이고 짧다(5~7초). 당일 수업이라 예약 마감(기본값)이
    // 이미 지나 있어 book 오버라이드가 필요하다.
    await saveSettings(centerAId, { ...defaultSettings, groupBookDaysBefore: 0, groupBookTime: "23:59" });
    const hoursFromNow = 8 / 3600; // 약 8초 뒤(CI 지연 여유)
    const cls = await createFutureTestClass(centerAId, { title: "RES-001 시작후취소불가", hoursFromNow });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const resId = await reserveAndGetId(cls.id);
    // 수업 시작이 확실히 지날 때까지 대기(여유 있게 12초)
    await new Promise((r) => setTimeout(r, 12000));

    const { error } = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("이미 시작되어 취소할 수 없어요");
  }, 20000);

  it("관리자 취소(manager_set_attendance)는 이 배치의 영향을 받지 않고 그대로 동작한다", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "RES-001 관리자취소", hoursFromNow: 240 });
    createdClassIds.push(cls.id);
    const mem = await createTestMembership(centerAId, managerA.profileId, { remainingCount: 2 });

    const resId = await reserveAndGetId(cls.id);
    await backdateCreatedAt(resId, 60); // 10분도, 일반 마감도 이미 지난 상태를 시뮬레이션

    const { error } = await supabase.rpc("manager_set_attendance", { p_reservation_id: resId, p_status: "cancelled" });
    expect(error).toBeNull();
    expect(await fetchMembershipRemaining(mem.id)).toBe(2); // 1(소모) → 2(복구), 마감 무관하게 항상 복구
  });

  it("이미 취소된 예약을 다시 취소하면 거부된다(중복 취소 방지, 기존 동작 유지)", async () => {
    const cls = await createFutureTestClass(centerAId, { title: "RES-001 중복취소", hoursFromNow: 240 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const resId = await reserveAndGetId(cls.id);
    const first = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(first.error).toBeNull();

    const second = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain("이미 취소된 예약이에요");
  });

  it("10분도 일반 마감도 지났지만 deduct_on_late_cancel이 켜져 있으면 취소는 되고 환급만 안 된다", async () => {
    // book 오버라이드 + deductOnLateCancel을 예약 전에 함께 설정해야 한다(뒤에서 다시 저장하면
    // book 오버라이드가 defaultSettings로 되돌아가 예약 자체가 막힘). 취소 마감도 pre-existing
    // 값에 기대지 않고 명시적으로 과거로 저장한다(위 테스트와 같은 이유).
    await saveSettings(centerAId, {
      ...defaultSettings,
      groupBookDaysBefore: 0, groupBookTime: "23:59",
      groupCancelDaysBefore: 0, groupCancelTime: ALWAYS_PAST_CANCEL_TIME,
      deductOnLateCancel: true,
    });
    const cls = await createKstSameDayFutureClass(centerAId, { title: "RES-001 차감옵션충돌", preferredMinutesFromNow: 120 });
    createdClassIds.push(cls.id);
    await createTestMembership(centerAId, managerA.profileId, { remainingCount: 3 });

    const resId = await reserveAndGetId(cls.id);
    // [수정] createTestMembership의 expires_at은 날짜(하루) 단위로만 저장되므로, 이 파일 안에서
    // 누적 생성된 여러 수강권이 같은 만료일을 공유할 수 있다 — reserve_class()의
    // "만료 임박순 1개 선택(order by expires_at asc limit 1)"이 동률을 어느 쪽으로 풀지는
    // 보장되지 않아, 앞선 테스트들의 수강권이 대신 선택될 수 있다("mem" 변수가 실제로 쓰였다는
    // 가정은 성립하지 않음). 실제로 이 예약이 소비한 membership_id를 직접 조회해 검증한다.
    const { data: resRow, error: resErr } = await supabase
      .from("reservations").select("membership_id").eq("id", resId).single();
    if (resErr || !resRow) throw new Error("예약의 membership_id 조회 실패: " + resErr?.message);
    const usedMembershipId = (resRow as any).membership_id as string;
    const beforeCancel = await fetchMembershipRemaining(usedMembershipId);

    await backdateCreatedAt(resId, 11);

    const { error } = await supabase.rpc("cancel_reservation", { p_reservation_id: resId });
    expect(error).toBeNull(); // 차단되지 않고 취소는 됨
    expect(await fetchMembershipRemaining(usedMembershipId)).toBe(beforeCancel); // 환급 없이 소모된 채로 유지
  });
});
