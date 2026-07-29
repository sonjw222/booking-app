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

// 계정이 없으면 생성하고, 있으면 재사용(get-or-create).
// 반환 후에는 supabase 싱글턴이 이 사용자로 로그인된 상태가 된다.
export async function switchToTestUser(emailEnvName: string, passwordEnvName: string): Promise<TestUser> {
  const email = requireEnv(emailEnvName);
  const password = requireEnv(passwordEnvName);

  await supabase.auth.signOut();

  const signIn = await supabase.auth.signInWithPassword({ email, password });
  let userId: string;
  if (signIn.error || !signIn.data.session) {
    const signUp = await supabase.auth.signUp({ email, password });
    if (signUp.error) {
      throw new Error(`테스트 계정(${email}) 준비 실패(signUp): ${signUp.error.message}`);
    }
    if (!signUp.data.session) {
      throw new Error(
        `테스트 계정(${email})이 생성됐지만 로그인 세션이 없습니다. Supabase Auth의 ` +
          `"Confirm email"이 켜져 있으면 가입 직후 바로 로그인할 수 없습니다. 개발 프로젝트에서 ` +
          `이 옵션을 끄거나, 이미 이메일 인증이 끝난 계정 정보를 ${emailEnvName}/${passwordEnvName}에 지정해주세요.`
      );
    }
    userId = signUp.data.session.user.id;
  } else {
    userId = signIn.data.session.user.id;
  }

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
