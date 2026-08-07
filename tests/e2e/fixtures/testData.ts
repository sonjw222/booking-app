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

export function saveTestAccountMeta(name: "manager-a" | "user-a" | "user-b", meta: TestUser): void {
  fs.mkdirSync(META_DIR, { recursive: true });
  fs.writeFileSync(path.join(META_DIR, `${name}.json`), JSON.stringify(meta));
}

export function loadTestAccountMeta(name: "manager-a" | "user-a" | "user-b"): TestUser {
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

// 이미 계산해 둔 KST 날짜(예: 다른 수업에서 파생된 날짜)에 정확히 맞춰 수업을 만든다 —
// hoursFromNow처럼 "지금부터 상대"로 계산하면, 테스트 중간에 여러 UI 라운드트립을 거치며
// 시간이 흘러(같은 hoursFromNow 값이라도 최초 계산 시점과 달라짐) 자정을 넘길 경우 의도한
// 날짜와 어긋날 수 있다(실제로 CI에서 재현 확인 — holiday-restores-classes.spec.ts가
// hoursFromNow: 5*24와 hoursFromNow: 5*24+1을 서로 다른 시점에 계산해 두 수업이 다른
// 날짜에 생기는 문제가 있었다). 절대 날짜를 명시하면 이 문제 자체가 사라진다.
export async function createClassOnKstDateAdmin(
  centerId: string,
  opts: { title: string; kstDate: string; kstTime?: string; capacity?: number }
): Promise<{ id: string; startTime: string }> {
  const admin = getFixtureAdminClient();
  await deleteExistingClassesByTitle(centerId, opts.title);
  const start = new Date(`${opts.kstDate}T${opts.kstTime ?? "10:00"}:00+09:00`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const { data, error } = await admin
    .from("classes")
    .insert({
      center_id: centerId,
      title: opts.title,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      capacity: opts.capacity ?? 8,
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

// 일일 예약 횟수 제한처럼 "오늘(KST) 확정+대기 예약 수"를 직접 세는 검증은, 이 센터를
// 공유하는 다른(과거) 테스트 실행이 남긴 leftover 확정 예약까지 함께 세어버리면 기준선이
// 이미 오염된 채로 시작한다(실제로 CI에서 재현: 새로 만든 예약 0건인데도 첫 시도부터
// "하루 예약 가능 횟수(2회)를 초과했어요"). 검증 직전에 이 프로필의 "오늘" 예약을 전부
// 지워 항상 0에서 시작하도록 보장한다.
export async function cleanupTodaysReservationsForProfile(centerId: string, profileId: string): Promise<void> {
  const admin = getFixtureAdminClient();
  const todayKst = kstDateStr(new Date().toISOString());
  const dayStartUtc = new Date(`${todayKst}T00:00:00+09:00`).toISOString();
  const dayEndUtc = new Date(`${todayKst}T23:59:59.999+09:00`).toISOString();

  const { data: classRows, error: clsErr } = await admin
    .from("classes")
    .select("id")
    .eq("center_id", centerId)
    .gte("start_time", dayStartUtc)
    .lte("start_time", dayEndUtc);
  if (clsErr) throw new Error(`오늘 수업 조회 실패: ${clsErr.message}`);
  const classIds = (classRows ?? []).map((c: any) => c.id as string);
  if (classIds.length === 0) return;

  const { error: delErr } = await admin
    .from("reservations")
    .delete()
    .eq("profile_id", profileId)
    .in("class_id", classIds)
    .in("status", ["confirmed", "waitlisted"]);
  if (delErr) throw new Error(`오늘 예약 정리 실패: ${delErr.message}`);
}

// ---------------- 수강권(admin) ----------------
// memberships.product_id는 nullable이지만, usable_memberships_for_classes()/
// usable_memberships()는 products를 INNER JOIN한다(fix_usable_memberships_product_kind.sql) —
// product_id가 null이면 이 두 RPC의 결과에서 그 수강권이 통째로 빠져, 회원 화면의 "사용할
// 수강권" 목록(passList)이 항상 비어 보인다. 그 상태에서 doReserve()는 passPick이 없으면
// reserveWithMembership()이 아니라 reserveClass()(자동 수강권 선택)로 폴백하므로, 실제
// 회원이 겪는 "수강권을 직접 골라 예약하는" 경로(reserveWithMembership)를 전혀 검증하지
// 못하게 된다 — 실측 CI에서 이 상태로 재현됨. 그래서 테스트 수강권에는 반드시 실제
// product_kind='pass' 상품을 만들어 연결한다.
// P3 감사에서 발견한 실제 앱 버그(app/manager/classes/page.tsx의 save()가 "모든 수강권
// 허용"으로 저장할 때도 센터의 전체 pass 상품에 membership_schedule_rules를 자동 추가해,
// 그 순간부터 그 pass가 "무제한"에서 "그 수업 조건에만 매칭"으로 조용히 좁혀지던 문제 —
// 코드는 고쳤지만, 그 버그가 살아있던 동안(이번 P3 배치 이전 포함, 실제 관리자 화면을
// 수동으로 써본 이전 세션들에서도 발생했을 수 있음) 이미 쌓인 규칙이 여전히 남아있다.
// "이 상품은 원래 무제한이어야 한다"고 테스트가 전제하는 공용 pass 상품(예: "E2E 테스트
// 수강권 상품")은 매 실행 전에 이 함수로 규칙을 깨끗이 비워 그 전제를 실제로 보장한다.
export async function clearScheduleRulesForProduct(productId: string): Promise<void> {
  const admin = getFixtureAdminClient();
  const { error } = await admin.from("membership_schedule_rules").delete().eq("product_id", productId);
  if (error) throw new Error(`membership_schedule_rules 정리 실패: ${error.message}`);
}

export async function getOrCreateTestPassProduct(centerId: string): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const name = "E2E 테스트 수강권 상품";
  const { data: existing, error: findErr } = await admin
    .from("products")
    .select("id")
    .eq("center_id", centerId)
    .eq("name", name)
    .eq("product_kind", "pass")
    .maybeSingle();
  if (findErr) throw new Error(`E2E 테스트 상품 조회 실패: ${findErr.message}`);
  if (existing) return { id: existing.id };

  const { data, error } = await admin
    .from("products")
    .insert({
      center_id: centerId,
      name,
      product_kind: "pass",
      pass_type: "count",
      total_count: 999,
      is_on_sale: true,
      is_active: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`E2E 테스트 상품 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id };
}

// P3: class_allowed_products 테스트는 "특정 수강권 1개만 허용"/"여러 개 허용"을 구분해서
// 검증해야 해서, 이름이 고정된 getOrCreateTestPassProduct() 하나로는 부족하다 — 이름을
// 받아 get-or-create하는 버전(같은 패턴, 이름만 파라미터화).
export async function getOrCreateTestPassProductNamed(centerId: string, name: string): Promise<{ id: string; name: string }> {
  const admin = getFixtureAdminClient();
  const { data: existing, error: findErr } = await admin
    .from("products")
    .select("id")
    .eq("center_id", centerId)
    .eq("name", name)
    .eq("product_kind", "pass")
    .maybeSingle();
  if (findErr) throw new Error(`E2E 테스트 상품(${name}) 조회 실패: ${findErr.message}`);
  if (existing) return { id: existing.id, name };

  const { data, error } = await admin
    .from("products")
    .insert({
      center_id: centerId,
      name,
      product_kind: "pass",
      pass_type: "count",
      total_count: 999,
      is_on_sale: true,
      is_active: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`E2E 테스트 상품(${name}) 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id, name };
}

export async function createTestMembershipAdmin(
  centerId: string,
  profileId: string,
  opts?: { remainingCount?: number }
): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const remaining = opts?.remainingCount ?? 5;
  const product = await getOrCreateTestPassProduct(centerId);
  const { data, error } = await admin
    .from("memberships")
    .insert({
      profile_id: profileId,
      center_id: centerId,
      product_id: product.id,
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

// P3: class_allowed_products 검증은 회원이 서로 다른 이름의 pass 여러 개를 동시에 보유한
// 상태가 필요하다(getOrCreateTestPassProductNamed와 짝) — 어느 product를 지급할지
// 파라미터로 받는 버전.
export async function createTestMembershipForProduct(
  centerId: string, profileId: string, product: { id: string; name: string },
  opts?: { remainingCount?: number }
): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const remaining = opts?.remainingCount ?? 5;
  // get-or-create — Playwright는 실패한 테스트를 재시도할 때 beforeAll도 처음부터 다시
  // 실행하는데, 매번 새로 insert하면 재시도 때마다 같은 (profile, product) 조합의 수강권이
  // 계속 쌓여 "정확히 1개만 보여야 한다"류 검증을 흔들어놓는다(CI에서 실제로 재현 —
  // "사용할 수강권" 목록에 같은 상품이 10개 넘게 나옴). 이미 활성 상태로 있으면 그걸 그대로
  // 재사용한다.
  // ⚠ .maybeSingle()은 행이 2개 이상이면 예외를 던진다 — 이 helper를 추가하기 전(P3
  // 배치 이전) 실패한 CI 재시도들이 이미 중복 행을 만들어둔 상태에서 실제로 이 예외가
  // 터지는 것을 확인했다. limit(1)로 "여러 개여도 아무거나 하나"를 재사용하도록 방어한다.
  const { data: existingRows, error: findErr } = await admin
    .from("memberships")
    .select("id")
    .eq("profile_id", profileId)
    .eq("center_id", centerId)
    .eq("product_id", product.id)
    .eq("status", "active")
    .limit(1);
  if (findErr) throw new Error(`E2E 테스트 수강권(${product.name}) 조회 실패: ${findErr.message}`);
  if (existingRows && existingRows.length > 0) {
    // status='active'만 보고 재사용하면, 이 계정이 공유하는 다른 스펙들의 자동매칭 예약
    // (reserve_class — 만료 임박순으로 아무 활성 수강권이나 골라 차감)이 이미 이 수강권의
    // remaining_count를 0까지 깎아놨어도 그대로 재사용해버려, "보유 pass인데 목록에 안
    // 보임" 회귀가 재현됐다(원인: WHERE remaining_count > 0 조건에서 조용히 탈락). 재사용
    // 시마다 잔여횟수/만료일을 원하는 값으로 되돌려 self-healing하게 만든다.
    const { error: refreshErr } = await admin
      .from("memberships")
      .update({
        remaining_count: remaining,
        expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      })
      .eq("id", existingRows[0].id);
    if (refreshErr) throw new Error(`E2E 테스트 수강권(${product.name}) 갱신 실패: ${refreshErr.message}`);
    return { id: existingRows[0].id };
  }

  const { data, error } = await admin
    .from("memberships")
    .insert({
      profile_id: profileId,
      center_id: centerId,
      product_id: product.id,
      product_name: product.name,
      pass_type: "count",
      total_count: remaining,
      remaining_count: remaining,
      expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`E2E 테스트 수강권(${product.name}) 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id };
}

// P0-3: "모든 수강권 사용 가능" 수업에서 goods(대여품 등, 예약용이 아님) 상품이 "사용할
// 수강권" 목록에 섞여 보이는지 검증하려면, 회원이 pass와 goods 두 종류를 동시에 보유한
// 상태를 실제로 만들어야 한다. product_kind='goods'인 상품+수강권을 get-or-create한다
// (createTestMembershipAdmin과 동일 패턴, pass 대신 goods).
export async function getOrCreateTestGoodsProduct(centerId: string): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const name = "E2E 테스트 대여품 상품";
  const { data: existing, error: findErr } = await admin
    .from("products")
    .select("id")
    .eq("center_id", centerId)
    .eq("name", name)
    .eq("product_kind", "goods")
    .maybeSingle();
  if (findErr) throw new Error(`E2E 테스트 goods 상품 조회 실패: ${findErr.message}`);
  if (existing) return { id: existing.id };

  const { data, error } = await admin
    .from("products")
    .insert({
      center_id: centerId,
      name,
      product_kind: "goods",
      pass_type: "count",
      total_count: 999,
      is_on_sale: true,
      is_active: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`E2E 테스트 goods 상품 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id };
}

export async function createTestGoodsMembershipAdmin(
  centerId: string,
  profileId: string,
  opts?: { remainingCount?: number }
): Promise<{ id: string }> {
  const admin = getFixtureAdminClient();
  const remaining = opts?.remainingCount ?? 5;
  const product = await getOrCreateTestGoodsProduct(centerId);
  const { data, error } = await admin
    .from("memberships")
    .insert({
      profile_id: profileId,
      center_id: centerId,
      product_id: product.id,
      product_name: "E2E 테스트 대여품",
      pass_type: "count",
      total_count: remaining,
      remaining_count: remaining,
      expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`E2E 테스트 goods 수강권 생성 실패: ${error?.message ?? "no data"}`);
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

// 운영설정(groupCancelDaysBefore=0/groupBookDaysBefore=0 + 시각)으로 "오늘 날짜 안에서
// 이미 지난/아직 안 지난 절대 시각"을 만들 때 쓰는 고정 HH:MM(KST) 상수 —
// cancel_deadline_min이 죽은 컬럼이라 마감 검증은 반드시 이 방식(오늘 날짜 + 시각)으로
// 해야 한다. 예전엔 "지금±N분"을 매번 계산했는데(kstTimeHHmm, 삭제됨), KST 자정
// 근처(22:00~23:59 또는 00:00~00:29)에 실행되면 그 상대 계산 자체가 날짜 경계를 넘어
// "오늘 날짜 + 그 시각"의 의미가 뒤집혀 버렸다(실제로 CI에서 재현·확인 —
// tests/integration/reservation-cancel-grace-period.test.ts와 동일한 문제).
// 상대 계산을 없애고 하루 중 가장 이르거나/늦은 고정 시각을 쓰면 이 문제가 구조적으로
// 사라진다 — 테스트가 그 1분 안에 실행되는 극히 드문 경우만 예외.
export const ALWAYS_PAST_TODAY_TIME = "00:01"; // 자정 1분 후 — "오늘 날짜 + 이 시각"은 거의 항상 이미 지남
export const ALWAYS_FUTURE_TODAY_TIME = "23:58"; // 자정 2분 전 — "오늘 날짜 + 이 시각"은 거의 항상 아직 안 지남

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
