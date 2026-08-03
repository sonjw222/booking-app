/*
  E2E 테스트 데이터 헬퍼(Node 측 — 브라우저가 아니라 Playwright 테스트 스크립트 자체에서
  실행됨). tests/integration/setup.ts의 검증된 fixture 헬퍼를 그대로 재사용해, "생성 →
  (브라우저로) 실행 → 삭제"를 각 스펙 파일의 beforeAll/afterAll에서 수행한다.
  이 파일은 통합 테스트와 완전히 같은 실제 개발용 Supabase/테스트 계정을 쓴다 — 실제 서비스
  데이터는 절대 건드리지 않는다(전용 테스트 센터/테스트 계정만 사용).
*/
export {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createTestMembership,
  createFutureTestClass,
  createKstSameDayFutureClass,
  kstSafeSameDayFutureTime,
  cleanupTestClass,
  type TestUser,
} from "../../integration/setup";

import { supabase } from "../../../lib/supabaseClient";

// 예약/취소 마감 override(분 단위, CLASS-001)까지 지정해야 하는 시나리오 전용 —
// createFutureTestClass에는 이 두 필드가 없어 별도로 만든다. 나머지 필드 기본값/반환 형태는
// createFutureTestClass와 동일하게 맞춰 헷갈리지 않게 한다.
export async function createFutureTestClassWithDeadlines(
  centerId: string,
  opts: {
    title: string;
    hoursFromNow: number;
    bookingDeadlineMin?: number | null;
    cancelDeadlineMin?: number | null;
    capacity?: number;
  }
): Promise<{ id: string; startTime: string }> {
  const start = new Date(Date.now() + opts.hoursFromNow * 3600 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const { data, error } = await supabase
    .from("classes")
    .insert({
      center_id: centerId,
      title: opts.title,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      capacity: opts.capacity ?? 8,
      booking_deadline_min: opts.bookingDeadlineMin ?? null,
      cancel_deadline_min: opts.cancelDeadlineMin ?? null,
    })
    .select("id, start_time")
    .single();
  if (error || !data) throw new Error(`E2E 테스트 수업 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id, startTime: data.start_time };
}

const KST_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });

// classes.start_time(UTC ISO) → 예약 화면이 쓰는 "YYYY-MM-DD"(KST) 문자열.
export function kstDateStr(startTimeIso: string): string {
  return KST_DATE.format(new Date(startTimeIso));
}

// 예약 화면의 "결제 완료 후 돌아오기" 딥링크(openClassId/openDate)를 재사용해, 달력에서
// 날짜/수업을 직접 클릭하지 않고도 바로 그 수업의 예약 확인 모달을 열리게 한다 — 실제
// 프로덕션 코드(app/reservation/page.tsx의 autoOpenDone 이펙트)가 이미 지원하는 경로다.
export function reservationDeepLink(classId: string, startTimeIso: string): string {
  return `/reservation?openClassId=${classId}&openDate=${encodeURIComponent(kstDateStr(startTimeIso))}`;
}

// 예약 직후 취소 시도 시 걸리는 "10분 유예"(cancel_reservation의 그레이스 기간)를 피하기
// 위해, reservations.created_at을 과거로 되돌려야 할 때 사용. 회원 본인 예약의 memo만
// 수정할 수 있는 RLS 정책의 부작용을 이용하는, tests/integration 쪽에서 이미 검증된
// 기법과 동일하다 — 새로 발명한 우회가 아니다.
export async function backdateReservationCreatedAt(reservationId: string, minutesAgo: number): Promise<void> {
  const { error } = await supabase
    .from("reservations")
    .update({ created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
    .eq("id", reservationId);
  if (error) throw new Error(`reservations.created_at 백데이트 실패: ${error.message}`);
}
