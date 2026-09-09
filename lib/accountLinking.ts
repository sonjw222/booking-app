/*
  이메일 ↔ 소셜 계정 명시적 연동(Account Linking)
  - 로그인 상태를 유지한 채 다른 계정임을 증명할 방법이 없어(OAuth 왕복은 세션을 덮어씀)
    일회성 코드 교환 방식을 쓴다. add_account_linking.sql의 RPC 2개를 그대로 감싼다.
  - 코드를 만든 계정(A)이 남고, 코드를 입력한 계정(B)이 A로 합쳐진다.
*/

import { createClient } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

// A(남을 계정)로 로그인한 상태에서 호출 — 10분 유효 코드 발급(이미 유효한 코드가 있으면 재사용)
export async function createAccountLinkCode(): Promise<string> {
  const { data, error } = await supabase.rpc("create_account_link_code");
  if (error) throw new Error(error.message);
  return data as string;
}

// B(합쳐질 계정)로 로그인한 상태에서 호출 — 성공하면 B의 데이터가 A로 재배정된다.
// 반환된 mergedAccountName은 "~ 계정으로 합쳐졌어요" 안내에 사용.
export async function linkAccountsByCode(code: string): Promise<{ mergedAccountName: string }> {
  const { data, error } = await supabase.rpc("link_accounts_by_code", { p_code: code });
  if (error) throw new Error(error.message);
  return data as { mergedAccountName: string };
}

// 신규 가입(주로 구글/애플 — 실제 이메일을 쓰는 provider) 직후, 지금 로그인 이메일로 이미
// 다른 계정이 있는지 확인한다. 카카오/네이버는 합성 이메일(DEC-004)이라 항상 null.
export async function checkMergeableAccountByEmail(): Promise<{ email: string } | null> {
  const { data, error } = await supabase.rpc("find_mergeable_account_by_my_email");
  if (error || !data) return null;
  return data as { email: string };
}

// 반응형 즉시 병합 — "이미 계정이 있어요, 합칠까요?" 확인 후 그 계정 비밀번호로 증명받아
// 바로 합친다. 지금 세션(B)은 그대로 유지한 채, 별도 격리된 Supabase 클라이언트로만
// 그 계정(A)에 로그인해 create_account_link_code()를 호출하고, 그 코드를 지금 세션(B)에서
// 바로 소비한다 — 코드 교환 방식(add_account_linking.sql)을 그대로 재사용, 새 병합 로직 없음.
export async function mergeViaPasswordVerification(email: string, password: string): Promise<{ mergedAccountName: string }> {
  const scratch = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { error: signInErr } = await scratch.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error("비밀번호가 올바르지 않아요");

  const { data: code, error: codeErr } = await scratch.rpc("create_account_link_code");
  await scratch.auth.signOut();
  if (codeErr || !code) throw new Error("연동 코드를 만들지 못했어요");

  return linkAccountsByCode(code as string);
}
