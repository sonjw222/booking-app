import { supabase } from "./supabaseClient";
import { edgeFunctionErrorMessage } from "./edgeFunctions";

// 계정 탈퇴 — supabase/functions/delete-account 참고.
// 개인정보(이름/전화번호/주소 등) 익명화 + auth.users 실제 삭제(재가입 허용)는 그 Edge
// Function(service_role) 쪽에서 하고, 여기서는 호출 + 로컬 세션 정리만 담당한다. auth.users가
// 삭제돼도 이미 발급된 access token은 만료 전까지 이론상 유효할 수 있어(짧은 수명, stateless
// 검증) signOut()으로 이 브라우저의 세션을 확실히 지운다.
export async function deactivateCurrentAccount(): Promise<void> {
  const { error } = await supabase.functions.invoke("delete-account");
  if (error) {
    throw new Error(await edgeFunctionErrorMessage(error, "탈퇴 처리에 실패했어요"));
  }
  await supabase.auth.signOut();
}
