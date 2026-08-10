/*
  통합 테스트 공용 헬퍼.
  - app이 실제로 쓰는 lib/supabaseClient.ts의 싱글턴 클라이언트를 그대로 재사용한다.
    (lib/orders.ts, lib/payments/*가 전부 이 싱글턴에 하드와이어링돼 있어서, 실제 코드를
    그대로 통합 테스트하려면 이 클라이언트로 로그인 상태를 만들어야 한다.)
  - 계정 A/B는 매번 새로 만들지 않고 get-or-create: 로그인 시도 → 실패하면 가입 → 그래도
    accounts/profiles 행이 없으면 그때 채워 넣는다.
  - 싱글턴이 하나뿐이라 동시에 두 계정 세션을 들고 있을 수 없으므로, 두 사용자가 필요한
    테스트(본인 소유 검증)는 signOut → signIn으로 "순서대로 전환"하는 방식을 쓴다.
*/

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabaseClient";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `통합 테스트에 필요한 환경변수 ${name}가 없습니다. .env.test.local(로컬) 또는 ` +
        `GitHub Actions Secrets(CI)에 설정해주세요 — 템플릿: .env.test.local.example`
    );
  }
  return value;
}

export const TEST_CENTER_ID = requireEnv("TEST_CENTER_ID");
export const TEST_PRODUCT_ID = requireEnv("TEST_PRODUCT_ID");

export type TestUser = {
  accountId: string;
  profileId: string;
};

type AccountRow = { id: string };
type ProfileRow = { id: string };

/*
  supabase-js의 GoTrueClient는 signOut()이 signInWithPassword()의 세션 저장(_saveSession)
  중간에 끼어들면 "commit guard"로 그 저장을 되돌리는 로직이 내부에 있다(auth-js 소스의
  _saveSession/_removeSession 주석 참고) — 즉 같은 client 인스턴스에서 signOut/signIn이
  겹쳐 호출되면 "방금 로그인했는데 세션이 없다"는 상태가 실제로 발생할 수 있다. 이 저장소의
  모든 통합 테스트 파일이 하나의 supabase 싱글턴(lib/supabaseClient.ts)을 공유하는 구조상
  (그래야 lib/orders.ts 등 실제 앱 코드를 그대로 테스트할 수 있음 — 위 파일 상단 설명 참고),
  파일 간 완전한 격리 대신 "auth를 바꾸는 모든 호출을 한 번에 하나씩만 실행되게" 직렬화해
  이 race 자체를 원천 차단한다.
*/
let authMutex: Promise<unknown> = Promise.resolve();
function withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = authMutex.then(fn, fn);
  authMutex = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// 계정이 없으면 생성하고, 있으면 재사용(get-or-create).
// 반환 후에는 supabase 싱글턴이 이 사용자로 로그인된 상태가 된다.
export async function switchToTestUser(emailEnvName: string, passwordEnvName: string): Promise<TestUser> {
  return withAuthLock(async () => {
    const email = requireEnv(emailEnvName);
    const password = requireEnv(passwordEnvName);

    // ⚠ scope: 'local' 필수 — 기본값(scope 생략 시 'global')은 이 계정의 세션을
    // "모든 곳에서" 강제 로그아웃시킨다. 이 Node 클라이언트 하나만 정리하면 되는데,
    // global로 호출하면 서버가 그 계정의 auth.sessions 행을 전부 지워버려 예를 들어
    // (E2E auth.setup.ts처럼) 이 함수를 계정 A → B 순서로 두 번 호출할 때, B 차례의
    // signOut(global)이 "이미 실제 브라우저로 로그인해 storageState까지 저장해둔 A의
    // 세션"까지 서버에서 무효화해버린다 — 실제로 이렇게 재현됨(Playwright에서
    // 403 session_not_found, tests/e2e/auth.setup.ts 파일 상단 히스토리 참고).
    await supabase.auth.signOut({ scope: "local" });

    const signIn = await supabase.auth.signInWithPassword({ email, password });
    let userId: string;
    if (signIn.error || !signIn.data.user || !signIn.data.session) {
      const signUp = await supabase.auth.signUp({ email, password });
      if (signUp.error) {
        throw new Error(`테스트 계정(${email}) 준비 실패(signUp): ${signUp.error.message}`);
      }
      if (!signUp.data.user || !signUp.data.session) {
        throw new Error(
          `테스트 계정(${email})이 생성됐지만 로그인 세션이 없습니다. Supabase Auth의 ` +
            `"Confirm email"이 켜져 있으면 가입 직후 바로 로그인할 수 없습니다. 개발 프로젝트에서 ` +
            `이 옵션을 끄거나, 이미 이메일 인증이 끝난 계정 정보를 ${emailEnvName}/${passwordEnvName}에 지정해주세요.`
        );
      }
      userId = signUp.data.user.id;
    } else {
      userId = signIn.data.user.id;
    }

    // signIn/signUp 응답의 user/session 필드로 로그인 결과를 이미 검사했다(위 if문).
    // 여기서 추가로 supabase.auth.getUser()를 다시 호출해 재검증하는 방식은 시도해봤지만,
    // 그 호출이 내부적으로 클라이언트의 "현재 세션" 상태를 다시 읽어오는 과정에서 방금 끝난
    // signIn의 내부 상태 반영과 타이밍이 어긋나 "Auth session missing!"을 던지는 새로운
    // flake를 만들어냈다(admin-assignment-security.test.ts에서 재현 확인). signIn/signUp이
    // 이미 반환한 session이 신뢰 가능한 결과이므로 추가 네트워크 재검증 없이 그대로 사용한다.

    const accountRes = await supabase.from("accounts").select("id").eq("auth_id", userId).maybeSingle();
    if (accountRes.error) throw new Error(`accounts 조회 실패: ${accountRes.error.message}`);
    let account = accountRes.data as AccountRow | null;
    if (!account) {
      const inserted = await supabase
        .from("accounts")
        .insert({ auth_id: userId, name: "통합테스트계정", is_member: true })
        .select("id")
        .single();
      if (inserted.error) throw new Error(`accounts 생성 실패: ${inserted.error.message}`);
      account = inserted.data as AccountRow;
    }

    // is_primary=true로 좁혀서 조회한다 — 계정 하나에 여러 profiles가 있을 수 있는데(회원이
    // 추가 프로필을 만들거나, 테스트가 "수강권 0건 상태"를 만들려고 추가 프로필을 임시로
    // 만드는 경우 등), account_id만으로 조회하면 행이 2개 이상일 때 .maybeSingle()이 예외를
    // 던져 이 계정으로 로그인하는 모든 테스트/E2E setup이 통째로 깨진다(실제로 재현됨 — 다른
    // 테스트가 만든 추가 프로필이 정리되기 전에 남아있던 상태에서). is_primary가 대표 프로필을
    // 가리키는 유일한 방법이라 이걸로 좁힌다.
    const profileRes = await supabase.from("profiles").select("id").eq("account_id", account.id).eq("is_primary", true).maybeSingle();
    if (profileRes.error) throw new Error(`profiles 조회 실패: ${profileRes.error.message}`);
    let profile = profileRes.data as ProfileRow | null;
    if (!profile) {
      const inserted = await supabase
        .from("profiles")
        .insert({ account_id: account.id, name: "통합테스트", is_primary: true })
        .select("id")
        .single();
      if (inserted.error) throw new Error(`profiles 생성 실패: ${inserted.error.message}`);
      profile = inserted.data as ProfileRow;
    }

    return { accountId: account.id, profileId: profile.id };
  });
}

// afterAll 등에서 세션을 정리할 때도 signOut()이 다른 곳에서 진행 중인 switchToTestUser()의
// signIn과 겹치지 않도록 같은 잠금을 통해 실행한다(위 withAuthLock 설명 참고).
export async function signOutTestSession(): Promise<void> {
  await withAuthLock(async () => {
    // scope: 'local' 필수 — 이유는 switchToTestUser() 위쪽 주석 참고.
    await supabase.auth.signOut({ scope: "local" });
  });
}

export type OrderRow = {
  id: string;
  status: "pending" | "paid" | "cancelled" | "done";
  payment_provider: string | null;
  pay_method: string | null;
  amount: number;
  profile_id: string;
  product_id: string | null;
  paid_at: string | null;
};

export async function fetchOrderRow(orderId: string): Promise<OrderRow> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, status, payment_provider, pay_method, amount, profile_id, product_id, paid_at")
    .eq("id", orderId)
    .single();
  if (error) throw new Error(`주문 조회 실패: ${error.message}`);
  return data as OrderRow;
}

export async function countMembershipsFor(profileId: string, productId: string): Promise<number> {
  const { count, error } = await supabase
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .eq("product_id", productId);
  if (error) throw new Error(`memberships 카운트 실패: ${error.message}`);
  return count ?? 0;
}

export type MembershipRow = {
  id: string;
  status: string;
  total_count: number | null;
  remaining_count: number | null;
};

export async function fetchLatestMembership(profileId: string, productId: string): Promise<MembershipRow | null> {
  const { data, error } = await supabase
    .from("memberships")
    .select("id, status, total_count, remaining_count")
    .eq("profile_id", profileId)
    .eq("product_id", productId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`memberships 조회 실패: ${error.message}`);
  return data as MembershipRow | null;
}

export type PaymentRow = {
  id: string;
  membership_id: string | null;
  total_amount: number;
  status: string;
  pg_transaction_id: string | null;
};

export async function fetchPaymentByMembership(membershipId: string): Promise<PaymentRow | null> {
  const { data, error } = await supabase
    .from("payments")
    .select("id, membership_id, total_amount, status, pg_transaction_id")
    .eq("membership_id", membershipId)
    .maybeSingle();
  if (error) throw new Error(`payments 조회 실패: ${error.message}`);
  return data as PaymentRow | null;
}

/* ============================================================
   관리자 직접배치/무료 추가 배치 통합 테스트 전용 fixture 헬퍼
   - 테스트 센터 생성 → 그 센터에 로그인 사용자를 오너로 연결하는 과정은 "아직 그 센터의
     매니저가 아닌 계정"이 스스로를 매니저로 만드는 닭-달걀 문제라, 일반 로그인 사용자 client로는
     (운영 RLS 정책이 실제로 무엇이든) 안전하게 보장할 수 없다. centers RLS를 테스트 통과를 위해
     느슨하게 바꾸는 대신, 이 fixture 준비 단계만 서비스 역할 키를 쓰는 별도 관리자 client로
     RLS를 우회해서 처리한다 — 운영 RLS 정책 자체는 전혀 건드리지 않는다.
   - 서비스 역할 client는 아래 fixture 준비에만 쓴다: 테스트 센터 조회/생성,
     manager_centers 오너 역할 조회/생성. 그 외 실제로 검증 대상인 admin_assign_reservation/
     admin_cancel_reservation RPC 호출과 권한 테스트는 전부 로그인 사용자별 일반 client(위 supabase
     싱글턴, switchToTestUser가 세션을 바꿔가며 사용)로 실행한다 — 그래야 실제 RLS/권한 검증이
     의미가 있다.
   ============================================================ */

let adminClient: SupabaseClient | null = null;

// SUPABASE_SERVICE_ROLE_KEY(JWT)의 role claim만 읽어본다(서명 검증 없음 — 여기서는 "anon 키를
// 잘못 넣지 않았는지"를 가려내기 위한 진단 목적일 뿐, 실제 인증/보안 검증이 아니다. 실제 권한
// 경계는 항상 Supabase 서버가 그 키로 검증한다).
function decodeJwtRoleClaim(token: string): string | null {
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) return null;
    const json = Buffer.from(payloadB64, "base64").toString("utf-8");
    const payload = JSON.parse(json);
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

// 서비스 역할 키를 쓰는 fixture 전용 관리자 client (지연 생성).
// SUPABASE_SERVICE_ROLE_KEY가 없는 파일(예: 기존 결제 통합 테스트)은 이 함수를 아예 호출하지
// 않으므로 영향받지 않는다 — setup.ts 최상단에서 미리 requireEnv하지 않는 이유.
export function getFixtureAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  // "centers new row violates row-level security policy" 같은 에러가 서비스 역할 client에서도
  // 계속 발생한다면, 코드가 일반 client로 새는 것이 아니라 이 값 자체가 진짜 service_role 키가
  // 아닐 가능성이 가장 크다(anon 키를 잘못 넣었거나, 다른 프로젝트의 키이거나). 여기서 role claim을
  // 먼저 확인해 그 경우 즉시 명확한 에러로 알려준다 — RLS 위반이라는 애매한 에러로 새지 않도록.
  const roleClaim = decodeJwtRoleClaim(serviceRoleKey);
  if (roleClaim !== "service_role") {
    throw new Error(
      `SUPABASE_SERVICE_ROLE_KEY 값이 service_role 키가 아닌 것 같습니다 ` +
        `(JWT의 role claim: ${roleClaim ?? "확인 불가(JWT 형식이 아님)"}). ` +
        `Supabase 대시보드 → Project Settings → API → "service_role secret"에서 정확한 값을 ` +
        `다시 복사해 등록해주세요(anon key와 혼동하기 쉽습니다). ` +
        `이 검사를 통과하지 못하면 fixture용 관리자 client를 만들지 않고 여기서 즉시 중단합니다.`
    );
  }

  adminClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return adminClient;
}

// service_role로 실행했는데도 실패하면 원인이 크게 둘로 갈린다:
//   1) "permission denied for table X" (Postgres 42501) — RLS가 아니라 그 테이블에 대한 SQL
//      GRANT 자체가 service_role에 없는 것. service_role은 RLS를 항상 우회하지만 GRANT는 별개다.
//   2) 그 외(RLS 관련 메시지 등) — 실제 에러 메시지를 그대로 보여준다.
// 여기서 바로 실행 가능한 GRANT 문을 안내해, "코드가 일반 client로 새는 건지" 다시 의심하지 않고
// 바로 원인(운영 Supabase 쪽 권한 설정)을 확인할 수 있게 한다.
export function describeAdminQueryError(table: string, error: { message: string; code?: string } | null | undefined): string {
  if (!error) return "원인 불명 (data 없음)";
  const isPermissionDenied = error.code === "42501" || /permission denied/i.test(error.message);
  if (isPermissionDenied) {
    return (
      `${error.message} — service_role이 "${table}" 테이블에 대한 SQL GRANT 자체가 없는 것으로 ` +
      `보입니다(RLS 문제 아님 — RLS는 service_role이 항상 우회하지만 테이블 GRANT는 별개입니다). ` +
      `Supabase SQL Editor에서 다음을 실행해 확인/복구해주세요: ` +
      `GRANT ALL ON TABLE ${table} TO service_role;`
    );
  }
  return error.message;
}

// 현재 로그인된 계정이 오너로 있는 센터를 재사용하거나, 없으면 새로 만들어 오너로 연결한다.
// RLS를 우회하는 서비스 역할 client로만 동작 — 일반 client는 전혀 쓰지 않는다.
export async function getOrCreateOwnedTestCenter(manager: TestUser): Promise<string> {
  const admin = getFixtureAdminClient();

  const { data: rows, error: mcErr } = await admin
    .from("manager_centers")
    .select("center_id, role_id")
    .eq("account_id", manager.accountId)
    .eq("status", "active");
  if (mcErr) throw new Error(`manager_centers 조회 실패: ${describeAdminQueryError("manager_centers", mcErr)}`);

  const roleIds = (rows ?? []).map((r: any) => r.role_id).filter(Boolean);
  if (roleIds.length > 0) {
    const { data: roles, error: roleErr } = await admin
      .from("center_roles")
      .select("id, is_owner")
      .in("id", roleIds);
    if (roleErr) throw new Error(`center_roles 조회 실패: ${describeAdminQueryError("center_roles", roleErr)}`);
    const ownerRoleIds = new Set((roles ?? []).filter((r: any) => r.is_owner).map((r: any) => r.id));
    const owned = (rows ?? []).find((r: any) => ownerRoleIds.has(r.role_id));
    if (owned) return (owned as any).center_id as string;
  }

  const { data: center, error: centerErr } = await admin
    .from("centers")
    .insert({ name: `통합테스트센터-${manager.accountId.slice(0, 8)}`, status: "pending" })
    .select("id")
    .single();
  if (centerErr || !center) throw new Error(`테스트 센터 생성 실패: ${describeAdminQueryError("centers", centerErr)}`);

  const { data: role, error: roleErr2 } = await admin
    .from("center_roles")
    .select("id")
    .eq("center_id", center.id)
    .eq("is_owner", true)
    .single();
  if (roleErr2 || !role) throw new Error(`오너 역할을 찾지 못했습니다: ${describeAdminQueryError("center_roles", roleErr2)}`);

  const { error: linkErr } = await admin
    .from("manager_centers")
    .insert({ account_id: manager.accountId, center_id: center.id, role_id: role.id, status: "active" });
  if (linkErr) throw new Error(`manager_centers 생성 실패: ${describeAdminQueryError("manager_centers", linkErr)}`);

  return center.id as string;
}

// 미래 시각에 시작하는 테스트 전용 수업 생성 (기본 48시간 뒤, 1시간짜리)
export async function createFutureTestClass(
  centerId: string,
  opts?: { capacity?: number; hoursFromNow?: number; title?: string; classFormat?: "group" | "private"; durationMinutes?: number }
): Promise<{ id: string; startTime: string; endTime: string }> {
  const hours = opts?.hoursFromNow ?? 48;
  const start = new Date(Date.now() + hours * 3600 * 1000);
  const end = new Date(start.getTime() + (opts?.durationMinutes ?? 60) * 60 * 1000);
  const { data, error } = await supabase
    .from("classes")
    .insert({
      center_id: centerId,
      title: opts?.title ?? "통합테스트 수업",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      // classes_private_capacity_check(fix_private_class_capacity_constraint_draft_proposed.sql)가
      // class_format='private'이면 capacity=1을 DB에서 강제한다 — private일 때 capacity 옵션은 무시.
      capacity: opts?.classFormat === "private" ? 1 : opts?.capacity ?? 8,
      class_format: opts?.classFormat ?? "group",
    })
    .select("id, start_time, end_time")
    .single();
  if (error || !data) throw new Error(`테스트 수업 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id, startTime: data.start_time, endTime: data.end_time };
}

// [OPS-BOUNDARY] "당일예약" 검증 전용 시각 계산.
// createFutureTestClass(hoursFromNow)는 Date.now() + N시간을 절대시간으로 더할 뿐이라,
// CI가 KST 21:00~23:59 사이에 시작되면 "+3시간"이 KST 자정을 넘겨 버려 만들어진 수업이
// "오늘"이 아닌 "내일" 수업이 된다 — reserve_class()의 당일예약 체크는
// (수업의 KST 날짜 = 오늘의 KST 날짜)로 판정하므로, 이 경우 체크 자체가 발동하지 않아
// 당일예약 OFF/ON 테스트의 전제가 CI 실행 시각에 따라 깨진다(실제로 재현 확인됨).
// 이 함수는 항상 "지금(KST)과 같은 달력 날짜 안"에서, now보다 충분히 뒤인 시각을 반환한다 —
// 선호 시간(preferredMinutesFromNow)이 KST 자정을 넘기면 자정 직전(minRunwayMinutes 여유)
// 까지로 줄인다. 열림/마감 판정은 수업의 KST "날짜"만 보고 시각 자체는 보지 않으므로
// (calc_deadline은 날짜 단위 오프셋), 이렇게 시간을 줄여도 다른 마감/오픈 조건에는
// 영향이 없다.
export function kstSafeSameDayFutureTime(preferredMinutesFromNow = 180, minRunwayMinutes = 2): Date {
  const now = new Date();
  const kstParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const y = Number(kstParts.find((p) => p.type === "year")!.value);
  const m = Number(kstParts.find((p) => p.type === "month")!.value);
  const d = Number(kstParts.find((p) => p.type === "day")!.value);

  // 달력 날짜(년/월/일 숫자)만 계산하는 용도로만 UTC 산술을 쓴다 — 실제 시각(instant)을
  // 만드는 게 아니라 "다음 날짜가 몇 년/몇 월/며칠인지"만 구하는 것이라 호스트 타임존과
  // 무관하다. 실제 시각은 항상 아래에서 명시적 +09:00 오프셋 문자열로만 만든다.
  const nextCalendarDayUtc = new Date(Date.UTC(y, m - 1, d + 1));
  const nextY = nextCalendarDayUtc.getUTCFullYear();
  const nextM = String(nextCalendarDayUtc.getUTCMonth() + 1).padStart(2, "0");
  const nextD = String(nextCalendarDayUtc.getUTCDate()).padStart(2, "0");
  const kstMidnightUtc = new Date(`${nextY}-${nextM}-${nextD}T00:00:00+09:00`);

  const latestSafe = new Date(kstMidnightUtc.getTime() - minRunwayMinutes * 60 * 1000);
  const preferred = new Date(now.getTime() + preferredMinutesFromNow * 60 * 1000);
  const target = preferred.getTime() < latestSafe.getTime() ? preferred : latestSafe;

  if (target.getTime() <= now.getTime()) {
    throw new Error(
      `kstSafeSameDayFutureTime: KST 자정까지 ${minRunwayMinutes}분의 여유도 없어 "오늘 안의 미래 시각"을 ` +
      `만들 수 없습니다. 잠시 후(KST 자정 이후) 다시 실행해주세요.`
    );
  }
  return target;
}

// 당일예약(same-day) 검증 전용 — 항상 KST 기준 "오늘" 안의 미래 시각으로 수업을 만든다.
// createFutureTestClass와 달리 CI 실행 시각(특히 KST 21~24시)과 무관하게 항상 오늘 날짜의
// 수업을 만들도록 보장한다. capacity/title 기본값 및 반환 형태는 createFutureTestClass와 동일.
export async function createKstSameDayFutureClass(
  centerId: string,
  opts?: { capacity?: number; title?: string; preferredMinutesFromNow?: number }
): Promise<{ id: string; startTime: string }> {
  const start = kstSafeSameDayFutureTime(opts?.preferredMinutesFromNow ?? 180);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const { data, error } = await supabase
    .from("classes")
    .insert({
      center_id: centerId,
      title: opts?.title ?? "통합테스트 수업(당일 경계)",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      capacity: opts?.capacity ?? 8,
    })
    .select("id, start_time")
    .single();
  if (error || !data) throw new Error(`테스트 수업 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id, startTime: data.start_time };
}

// 테스트용 수강권(횟수권) 생성. expired:true면 만료된 수강권(과거 만료일 + status='expired')을 만든다.
// get-or-create + self-healing refresh(2026-08 오염 진단 후 도입) — 예전엔 호출마다 무조건
// insert해서, 이 헬퍼를 쓰는 15개 넘는 통합테스트 파일이 매 CI 실행마다 같은 (profile,
// center) 조합에 새 "통합테스트 수강권" 행을 계속 쌓았다(afterAll 정리가 있는 파일도 CI가
// 중간 취소되면 실행 자체가 안 됨 — GitHub Actions concurrency.cancel-in-progress나 사람이
// 새 실행을 다시 트리거하면 이전 실행이 그대로 죽는다). 실측 진단에서 이 문자열 하나로
// centerA에 979건 이상(PostgREST 1000행 응답 캡에 걸릴 정도) 쌓여 있는 것을 확인했고, 이게
// class-allowed-products.spec.ts 등 "이 프로필의 사용 가능한 수강권 전체"를 나열하는 화면이
// 간헐적으로 타임아웃/오염되던 진짜 원인이었다. createTestMembershipForProduct()가 이미
// 증명한 것과 같은 패턴 — (profile, center, product_id is null) 조합을 재사용하고 매번
// 요청받은 상태로 덮어쓴다. 상태(active/expired)가 달라도 같은 행을 재사용해 그 상태로
// 되돌린다 — 이 헬퍼를 쓰는 테스트들은 "정확히 이 속성을 가진 나만의 수강권 1개"만 필요로
// 하지, 과거 호출과 동시에 여러 개 공존해야 하는 케이스는 없다(파일별 감사로 확인).
export async function createTestMembership(
  centerId: string,
  profileId: string,
  opts?: { remainingCount?: number; expired?: boolean }
): Promise<{ id: string; remainingCount: number | null }> {
  const expired = opts?.expired ?? false;
  const remaining = opts?.remainingCount ?? 5;
  const expiresAt = expired
    ? new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    : new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const { data: existing, error: findErr } = await supabase
    .from("memberships")
    .select("id")
    .eq("profile_id", profileId)
    .eq("center_id", centerId)
    .is("product_id", null)
    .eq("product_name", "통합테스트 수강권")
    .limit(1);
  if (findErr) throw new Error(`테스트 수강권 조회 실패: ${findErr.message}`);

  if (existing && existing.length > 0) {
    const { data, error } = await supabase
      .from("memberships")
      .update({
        total_count: remaining,
        remaining_count: expired ? 0 : remaining,
        expires_at: expiresAt,
        status: expired ? "expired" : "active",
      })
      .eq("id", existing[0].id)
      .select("id, remaining_count")
      .single();
    if (error || !data) throw new Error(`테스트 수강권 갱신 실패: ${error?.message ?? "no data"}`);
    return { id: data.id, remainingCount: data.remaining_count };
  }

  const { data, error } = await supabase
    .from("memberships")
    .insert({
      profile_id: profileId,
      center_id: centerId,
      product_name: "통합테스트 수강권",
      pass_type: "count",
      total_count: remaining,
      remaining_count: expired ? 0 : remaining,
      expires_at: expiresAt,
      status: expired ? "expired" : "active",
    })
    .select("id, remaining_count")
    .single();
  if (error || !data) throw new Error(`테스트 수강권 생성 실패: ${error?.message ?? "no data"}`);
  return { id: data.id, remainingCount: data.remaining_count };
}

export async function fetchMembershipRemaining(membershipId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("memberships")
    .select("remaining_count")
    .eq("id", membershipId)
    .single();
  if (error) throw new Error(`수강권 조회 실패: ${error.message}`);
  return (data as any).remaining_count;
}

// 정리(best-effort): admin_cancel_reservation으로 취소 → 취소된 예약만 삭제 가능한 RLS를 만족시킨 뒤
// class_id로 남은 예약과 수업 자체를 지운다. memberships는 매니저 delete RLS 정책이 없어 지우지 못하고
// 남는다(payments/orders와 동일한 기존 제약 — reset_test_data.sql로 주기적으로 정리).
export async function cleanupTestClass(classId: string, reservationIds: string[]): Promise<void> {
  for (const id of reservationIds) {
    try {
      await supabase.rpc("admin_cancel_reservation", { p_reservation_id: id, p_cancel_reason: "integration test cleanup" });
    } catch {
      // 이미 취소됐거나 대상이 아니면 무시 (best-effort 정리)
    }
  }
  try {
    await supabase.from("reservations").delete().eq("class_id", classId);
  } catch { /* 무시 */ }
  try {
    await supabase.from("classes").delete().eq("id", classId);
  } catch { /* 무시 */ }
}

// cleanupTestClass()의 raw delete는 매니저 세션(RLS) 기준이라 "매니저 취소예약 정리" 정책
// (reservation_functions.sql, status in ('cancelled','no_show')만 허용)에 걸려 waitlisted/
// confirmed/attended 상태로 남은 예약은 에러 없이 조용히 삭제되지 않는다(0건 삭제, 예외 아님)
// — private-class-capacity.test.ts에서 이미 한 번 발견/우회된 것과 동일한 원인이며,
// attendance-policy.test.ts가 이 패턴으로 매 실행 waitlisted 예약을 남겨 실제로 3일간 13건
// 누적된 것을 실측 확인했다(docs/TODO.md P1-14). admin(service_role)은 RLS를 우회하므로
// 예약 상태와 무관하게 확실히 지운다 — 테스트가 끝난 뒤 non-terminal 상태로 남을 수 있는
// 예약을 만드는 파일은 cleanupTestClass 대신 이 함수를 쓴다.
export async function cleanupTestClassAdmin(classId: string): Promise<void> {
  const admin = getFixtureAdminClient();
  await admin.from("reservations").delete().eq("class_id", classId);
  await admin.from("classes").delete().eq("id", classId);
}
