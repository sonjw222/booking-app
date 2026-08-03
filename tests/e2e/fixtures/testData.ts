/*
  E2E 테스트 데이터 헬퍼(Node 측 — 브라우저가 아니라 Playwright 테스트 스크립트 자체에서
  실행됨).

  ⚠️ 매우 중요 — 반드시 admin(service-role) client로만 쓰고 읽는다.
  처음에는 tests/integration/setup.ts의 switchToTestUser()로 managerA/userA로 직접
  로그인해서 픽스처를 만들었는데, 실제 CI 실행에서 e2e 스펙 8개가 전부 "로그인이
  필요해요"로 깨졌다. 네트워크 트레이스로 직접 원인을 확인: Node 쪽에서 managerA/userA로
  signInWithPassword()를 다시 호출할 때마다, 브라우저가 auth.setup.ts에서 이미 로그인해
  storageState로 저장해둔 "그 계정"의 세션이 즉시 무효화됐다(다음 요청에서 Supabase가
  403 session_not_found를 반환 — 실측 확인, 추측 아님). 즉 "브라우저 세션을 재사용"하는
  것과 "Node에서 같은 계정으로 반복 재로그인해 픽스처를 만드는 것"은 근본적으로 양립할 수
  없다.

  그래서 구조를 바꿨다: 이 파일은 managerA/userA로 다시는 로그인하지 않는다(=RLS를
  거치지 않는다) — admin client로 직접 테이블을 읽고 쓴다. 실제 RLS를 통과해야 하는 행동
  (설정 저장 버튼 클릭, 예약/취소 버튼 클릭)은 전부 브라우저(storageState로 로그인된 상태)가
  수행한다 — 애초에 이게 각 스펙이 검증하려는 대상이므로, 오히려 이쪽이 더 정확하다.

  managerA/userA의 accountId/profileId는 auth.setup.ts가 "브라우저 로그인 직전에 딱
  한 번만" switchToTestUser로 조회해 JSON 파일로 저장해두고(그 시점 이후로 이 두 계정으로
  다시 로그인하는 코드는 e2e 스위트 어디에도 없다), 이 파일의 loadTestAccountMeta()가
  그 값을 읽어 재사용한다.
*/
import fs from "node:fs";
import path from "node:path";
import { getFixtureAdminClient, switchToTestUser, getOrCreateOwnedTestCenter, kstSafeSameDayFutureTime, type TestUser } from "../../integration/setup";
import { rowToSettings, settingsToRow, DEFAULT_SETTINGS, type CenterSettings } from "../../../lib/settings";

export { switchToTestUser, getOrCreateOwnedTestCenter, kstSafeSameDayFutureTime, type TestUser };

// 같은 제목의 이전 실행 잔여 행(있다면 그 예약까지)을 지운다 — CI가 실행 도중
// concurrency로 취소되면 afterAll이 못 돌아 이전 실행이 만든 같은 제목의 수업이
// 그대로 남는데(실제로 재현됨: 회원 화면에서 같은 제목 행이 여러 개 나와 Playwright의
// strict mode violation로 이어짐), "이 제목은 이 센터에 항상 하나만" 원칙으로 생성 전에
// 매번 정리해 재실행/재시도에도 정확히 1건만 남긴다.
async function deleteExistingClassesByTitle(centerId: string, title: string): Promise<void> {
  const admin = getFixtureAdminClient();
  const { data: existing } = await admin.from("classes").select("id").eq("center_id", centerId).eq("title", title);
  const ids = (existing ?? []).map((r: any) => r.id as string);
  if (ids.length === 0) return;
  await admin.from("reservations").delete().in("class_id", ids);
  await admin.from("classes").delete().in("id", ids);
}

// ---------------- managerA/userA accountId/profileId 저장·조회 ----------------
// auth.setup.ts가 브라우저 로그인 "직전"에 Node에서 딱 한 번 switchToTestUser로 조회해
// 여기 저장해둔다 — 그 이후 이 값을 읽기만 할 뿐, 이 두 계정으로 다시 로그인하지 않는다.
const META_DIR = path.resolve(process.cwd(), "playwright/.auth");

export function saveTestAccountMeta(name: "manager-a" | "user-a", meta: TestUser): void {
  fs.mkdirSync(META_DIR, { recursive: true });
  fs.writeFileSync(path.join(META_DIR, `${name}.json`), JSON.stringify(meta));
}

export function loadTestAccountMeta(name: "manager-a" | "user-a"): TestUser {
  const raw = fs.readFileSync(path.join(META_DIR, `${name}.json`), "utf-8");
  return JSON.parse(raw) as TestUser;
}

// ---------------- 수업 생성(admin) ----------------
// 예약마감 override(분 단위, CLASS-001)까지 지정해야 하는 시나리오 전용.
//
// ⚠ cancel_deadline_min은 여기서 다루지 않는다: classes.cancel_deadline_min은 DB에서
// NOT NULL DEFAULT 0이고(schema.sql), fix_class_booking_deadline_override_draft_proposed.sql이
// booking_deadline_min만 "명시하면 최우선 적용"으로 고쳤을 뿐 cancel_deadline_min은 의도적으로
// 범위에서 제외했다(그 파일 자체의 주석 참고) — cancel_reservation()은 지금도 운영설정
// calc_deadline('cancel')을 항상 먼저 쓰고, 그게 null일 때만 이 컬럼을 본다(사실상 죽은
// 컬럼). 취소 마감 검증은 운영설정(groupCancelDaysBefore/Time)으로 해야 한다.
export async function createFutureTestClassAdmin(
  centerId: string,
  opts: { title: string; hoursFromNow: number; bookingDeadlineMin?: number | null; capacity?: number }
): Promise<{ id: string; startTime: string }> {
  const admin = getFixtureAdminClient();
  await deleteExistingClassesByTitle(centerId, opts.title);
  const start = new Date(Date.now() + opts.hoursFromNow * 3600 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const { data, error } = await admin
    .from("classes")
    .insert({
      center_id: centerId,
      title: opts.title,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      capacity: opts.capacity ?? 8,
      booking_deadline_min: opts.bookingDeadlineMin ?? null,
    })
    .select("id, start_time")
    .single();
  if (error || !data) throw new Error(`E2E 테스트 수업 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id, startTime: data.start_time };
}

// 당일예약 시나리오 전용 — KST 자정 경계를 안전하게 피한다(kstSafeSameDayFutureTime 재사용).
export async function createKstSameDayFutureClassAdmin(
  centerId: string,
  opts?: { capacity?: number; title?: string; preferredMinutesFromNow?: number }
): Promise<{ id: string; startTime: string }> {
  const admin = getFixtureAdminClient();
  const title = opts?.title ?? "E2E 당일 테스트 수업";
  await deleteExistingClassesByTitle(centerId, title);
  const start = kstSafeSameDayFutureTime(opts?.preferredMinutesFromNow ?? 180);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const { data, error } = await admin
    .from("classes")
    .insert({
      center_id: centerId,
      title,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      capacity: opts?.capacity ?? 8,
    })
    .select("id, start_time")
    .single();
  if (error || !data) throw new Error(`E2E 테스트 수업 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id, startTime: data.start_time };
}

export async function cleanupTestClassAdmin(classId: string): Promise<void> {
  const admin = getFixtureAdminClient();
  await admin.from("reservations").delete().eq("class_id", classId);
  await admin.from("classes").delete().eq("id", classId);
}

// ---------------- 수강권(admin) ----------------
export async function createTestMembershipAdmin(
  centerId: string,
  profileId: string,
  opts?: { remainingCount?: number }
): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const remaining = opts?.remainingCount ?? 5;
  const { data, error } = await admin
    .from("memberships")
    .insert({
      profile_id: profileId,
      center_id: centerId,
      product_name: "E2E 테스트 수강권",
      pass_type: "count",
      total_count: remaining,
      remaining_count: remaining,
      expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`E2E 테스트 수강권 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id };
}

// ---------------- 운영설정(admin) ----------------
// rowToSettings/settingsToRow는 lib/settings.ts가 이미 쓰던 컬럼 매핑을 그대로 재사용한다
// (매핑 중복 방지) — fetchSettings/saveSettings 자체(RLS 경유)만 admin으로 바꾼 것.
export async function fetchSettingsAdmin(centerId: string): Promise<CenterSettings> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin.from("center_settings").select("*").eq("center_id", centerId).maybeSingle();
  if (error) throw new Error("설정을 불러오지 못했어요(admin): " + error.message);
  if (!data) return { ...DEFAULT_SETTINGS };
  return rowToSettings(data);
}

export async function saveSettingsAdmin(centerId: string, s: CenterSettings): Promise<void> {
  const admin = getFixtureAdminClient();
  const { error } = await admin.from("center_settings").upsert(settingsToRow(centerId, s), { onConflict: "center_id" });
  if (error) throw new Error("설정 저장에 실패했어요(admin): " + error.message);
}

// 운영설정(groupCancelDaysBefore=0 + groupCancelTime)으로 "지금부터 N분 뒤/전"이라는
// 절대 취소마감 시각을 만들 때 쓰는 HH:MM(KST) 문자열 — cancel_deadline_min이 죽은
// 컬럼이라 취소마감 검증은 반드시 이 방식(오늘 날짜 + 시각)으로 해야 한다.
export function kstTimeHHmm(offsetMinutesFromNow: number): string {
  const t = new Date(Date.now() + offsetMinutesFromNow * 60_000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(t);
  const hh = parts.find((p) => p.type === "hour")!.value;
  const mm = parts.find((p) => p.type === "minute")!.value;
  return `${hh === "24" ? "00" : hh}:${mm}`;
}

// ---------------- 예약(admin, 취소 시나리오 픽스처 전용) ----------------
// reserve_class() RPC를 거치지 않고 admin으로 직접 "확정 예약" 행을 만든다 — 취소
// 버튼/화면 검증이 목적이지 예약 생성 자체의 정확성은 이미 다른 곳에서 검증됐으므로,
// created_at을 원하는 과거 시각으로 바로 지정해 "10분 그레이스" 예외도 자연스럽게 피한다.
export async function insertConfirmedReservationAdmin(
  classId: string,
  profileId: string,
  opts?: { membershipId?: string | null; createdAtIso?: string }
): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("reservations")
    .insert({
      class_id: classId,
      profile_id: profileId,
      membership_id: opts?.membershipId ?? null,
      status: "confirmed",
      created_at: opts?.createdAtIso ?? new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`E2E 테스트 예약 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id };
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
