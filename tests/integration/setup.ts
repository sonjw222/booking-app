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

    await supabase.auth.signOut();

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

    const profileRes = await supabase.from("profiles").select("id").eq("account_id", account.id).maybeSingle();
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
    await supabase.auth.signOut();
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

  // status를 처음부터 'approved'로 insert한다 — guard_center_status_change() 트리거는
  // "before update"에만 걸려 있어 INSERT는 막지 않는다(P2-15). reserve_class() 등 승인된
  // 센터를 요구하는 RPC를 호출하는 테스트가 있어 애초에 승인 상태로 만든다.
  const { data: center, error: centerErr } = await admin
    .from("centers")
    .insert({ name: `통합테스트센터-${manager.accountId.slice(0, 8)}`, status: "approved" })
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
  opts?: { capacity?: number; hoursFromNow?: number; title?: string }
): Promise<{ id: string; startTime: string }> {
  const hours = opts?.hoursFromNow ?? 48;
  const start = new Date(Date.now() + hours * 3600 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const { data, error } = await supabase
    .from("classes")
    .insert({
      center_id: centerId,
      title: opts?.title ?? "통합테스트 수업",
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
