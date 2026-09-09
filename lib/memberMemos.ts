/*
  회원 메모 (member_memos) — 스태프 전용, 회원 본인은 절대 조회 불가.
  RLS: add_customer_memo_feature.sql — 조회는 customer.memo.view, 작성은 customer.memo.create,
  수정/삭제는 본인 작성분(customer.memo.update/delete) 또는 그 센터 오너(_is_owner_of_center).
*/

import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";

export type MemberMemo = {
  id: string;
  content: string;
  createdAt: string;
  authorAccountId: string;
  authorName: string;
};

export async function fetchMemberMemos(profileId: string): Promise<MemberMemo[]> {
  const { data, error } = await supabase
    .from("member_memos")
    .select("id, content, created_at, author_account_id, accounts(name)")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true });
  if (error) throw new Error("메모를 불러오지 못했어요: " + error.message);
  return (data ?? []).map((m: any) => ({
    id: m.id,
    content: m.content,
    createdAt: m.created_at,
    authorAccountId: m.author_account_id,
    authorName: m.accounts?.name ?? "알 수 없음",
  }));
}

export async function createMemberMemo(profileId: string, centerId: string, content: string): Promise<void> {
  const myAccountId = await getMyAccountId();
  if (!myAccountId) throw new Error("계정을 확인할 수 없어요");
  const { error } = await supabase.from("member_memos").insert({
    profile_id: profileId, center_id: centerId, content, author_account_id: myAccountId,
  });
  if (error) throw new Error("메모 등록에 실패했어요: " + error.message);
}

export async function updateMemberMemoEntry(memoId: string, content: string): Promise<void> {
  const { error } = await supabase.from("member_memos").update({ content }).eq("id", memoId);
  if (error) throw new Error("메모 수정에 실패했어요: " + error.message);
}

export async function deleteMemberMemoEntry(memoId: string): Promise<void> {
  const { error } = await supabase.from("member_memos").delete().eq("id", memoId);
  if (error) throw new Error("메모 삭제에 실패했어요: " + error.message);
}
