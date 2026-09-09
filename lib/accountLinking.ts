/*
  이메일 ↔ 소셜 계정 명시적 연동(Account Linking)
  - 로그인 상태를 유지한 채 다른 계정임을 증명할 방법이 없어(OAuth 왕복은 세션을 덮어씀)
    일회성 코드 교환 방식을 쓴다. add_account_linking.sql의 RPC 2개를 그대로 감싼다.
  - 코드를 만든 계정(A)이 남고, 코드를 입력한 계정(B)이 A로 합쳐진다.
*/

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
