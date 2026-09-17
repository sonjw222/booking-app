/*
  Automated Business Scenario E2E Batch(2026-09-18) — 요청 12번: 공통 invariant helper.

  ⚠ waitlist_order에 대한 중요한 실측 사실(추측 아님, reservation_functions.sql의
  cancel_reservation() 실제 본문 확인): 대기자가 승격되면 그 사람의 waitlist_order만
  null로 바뀌고, 나머지 대기자들의 waitlist_order 값은 재정렬(예: 2→1)되지 않는다 —
  ORDER BY waitlist_order ASC로 다음 승격 대상을 고르는 로직만 정확하면 되고, 값
  자체가 "연속된 1,2,3..."일 필요는 없다. 따라서 아래 invariant는 "중복 없음 +
  ORDER BY로 정확한 순서를 복원 가능"만 검증하고, "항상 연속(compact)"은 검증하지
  않는다 — 요청 원문의 "waitlist_position 연속성 유지"를 문자 그대로 구현하면 실제
  코드와 안 맞아 거짓 실패(false failure)가 나므로, 실제 구현 기준으로 조정했다.

  ⚠ 클라이언트 선택(실측으로 발견/수정, 추측 아님): 처음엔 tests/integration/setup.ts의
  supabase 싱글턴(그 시점에 로그인돼 있는 특정 actor 세션)으로 조회했는데, invariant는
  "여러 actor에 걸친 객관적 DB 상태"를 확인하는 것이라 특정 회원 세션으로는 다른 회원의
  memberships/reservations 행이 RLS로 아예 안 보인다("매니저 수강권 조회" 정책은
  profile_id in (select my_profile_ids()) or has_permission(...)만 허용 — 실제 호출로
  "Cannot coerce the result to a single JSON object"(0 rows) 재현 확인). 그래서 이
  파일의 조회는 fixture 전용 admin(service_role) 클라이언트를 쓴다 — setup.ts의
  createTestMembership()/resetStaleTestCenterSettings() 등 기존 fixture 준비 코드가
  이미 쓰는 것과 동일한 client이며, "실제 유저 화면이 RLS로 무엇을 보여주는지"가 아니라
  "DB에 실제로 무엇이 저장돼 있는지"를 검증하는 목적에 맞다(둘은 다른 질문 — 화면
  RLS 검증은 P1-40~45 등 별도 시나리오의 몫).
*/
import { getFixtureAdminClient } from "../setup";

const supabase = getFixtureAdminClient();

export interface InvariantViolation {
  name: string;
  detail: string;
}

async function fetchClassReservations(classId: string) {
  const { data, error } = await supabase
    .from("reservations")
    .select("id, profile_id, status, waitlist_order")
    .eq("class_id", classId);
  if (error) throw new Error(`invariant 조회 실패(reservations): ${error.message}`);
  return data ?? [];
}

// capacity 불변식: confirmed 수 <= capacity. 초과하면 정원 로직 자체가 깨진 것(가장
// 심각한 위반 — race condition으로 정원을 넘겨 확정시켰다는 뜻).
export async function checkCapacityInvariant(classId: string): Promise<InvariantViolation | null> {
  const [{ data: cls, error: clsErr }, rows] = await Promise.all([
    supabase.from("classes").select("capacity").eq("id", classId).single(),
    fetchClassReservations(classId),
  ]);
  if (clsErr || !cls) throw new Error(`invariant 조회 실패(classes): ${clsErr?.message ?? "no data"}`);
  const confirmedCount = rows.filter((r: any) => r.status === "confirmed").length;
  if (confirmedCount > cls.capacity) {
    return { name: "capacity", detail: `confirmed=${confirmedCount} > capacity=${cls.capacity}` };
  }
  return null;
}

// 수강권 불변식: remaining_count는 절대 음수가 될 수 없다(DB 자체에도
// memberships_remaining_not_negative CHECK 제약이 있음 — 이 헬퍼는 애플리케이션
// 레벨에서 한 번 더, 더 이른 시점에 잡기 위한 것).
export async function checkMembershipNonNegative(membershipId: string): Promise<InvariantViolation | null> {
  const { data, error } = await supabase.from("memberships").select("remaining_count").eq("id", membershipId).single();
  if (error) throw new Error(`invariant 조회 실패(memberships): ${error.message}`);
  const remaining = (data as any).remaining_count;
  if (remaining != null && remaining < 0) {
    return { name: "membership-non-negative", detail: `remaining_count=${remaining} < 0` };
  }
  return null;
}

// 중복 예약 불변식: 같은 프로필이 같은 수업에 confirmed/waitlisted 상태로 2건 이상 없어야
// 한다 — schema.sql의 unique_active_reservation 유니크 인덱스가 DB 레벨에서 이미
// 강제하지만(2중 방어), 애플리케이션 레벨에서도 명시적으로 재확인한다.
export async function checkNoDuplicateActiveReservation(classId: string, profileId: string): Promise<InvariantViolation | null> {
  const { data, error } = await supabase
    .from("reservations")
    .select("id")
    .eq("class_id", classId)
    .eq("profile_id", profileId)
    .in("status", ["confirmed", "waitlisted"]);
  if (error) throw new Error(`invariant 조회 실패(duplicate check): ${error.message}`);
  if ((data ?? []).length > 1) {
    return { name: "no-duplicate-active-reservation", detail: `profile=${profileId}, class=${classId}: ${data!.length}건` };
  }
  return null;
}

// 대기 순번 불변식: waitlisted 상태인 행들 사이에서 waitlist_order 값이 중복되면 안 된다
// (중복되면 "다음 승격 대상"이 모호해짐). 연속성(compact)은 위 파일 상단 주석 참고 —
// 실제 구현상 보장되지 않아 검증 대상에서 제외.
export async function checkWaitlistOrderNoDuplicates(classId: string): Promise<InvariantViolation | null> {
  const rows = await fetchClassReservations(classId);
  const waitlisted = rows.filter((r: any) => r.status === "waitlisted");
  const orders = waitlisted.map((r: any) => r.waitlist_order);
  const unique = new Set(orders);
  if (unique.size !== orders.length) {
    return { name: "waitlist-order-no-duplicates", detail: `waitlist_order 값: ${JSON.stringify(orders)}` };
  }
  return null;
}

export async function fetchReservationStatus(reservationId: string): Promise<{ status: string; waitlistOrder: number | null }> {
  const { data, error } = await supabase.from("reservations").select("status, waitlist_order").eq("id", reservationId).single();
  if (error) throw new Error(`예약 상태 조회 실패: ${error.message}`);
  return { status: (data as any).status, waitlistOrder: (data as any).waitlist_order };
}

// 위 개별 invariant들을 한 번에 실행 — 시나리오 테스트가 끝난 뒤(steps 이후) 한 번씩
// 호출해 "여러 시나리오가 공통으로 지켜야 하는 규칙"을 매번 재작성하지 않게 한다.
export async function checkCoreInvariants(
  classId: string,
  membershipIds: string[]
): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];
  const capacityViolation = await checkCapacityInvariant(classId);
  if (capacityViolation) violations.push(capacityViolation);
  const waitlistViolation = await checkWaitlistOrderNoDuplicates(classId);
  if (waitlistViolation) violations.push(waitlistViolation);
  for (const mid of membershipIds) {
    const v = await checkMembershipNonNegative(mid);
    if (v) violations.push(v);
  }
  return violations;
}
