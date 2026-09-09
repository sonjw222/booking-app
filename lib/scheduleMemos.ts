/*
  수업 상세페이지 메모 (schedule_memos, class_id 경로만 — 기타일정 메모는 범위 밖)
  RLS: add_schedule_memo_feature.sql — 조회는 그 센터 매니저 전체, 작성은 schedule.memo.create,
  수정/삭제는 본인 작성분 또는 schedule.memo.update/delete 권한(오너는 항상 허용).
*/

import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";

export type ScheduleMemo = {
  id: string;
  content: string;
  createdAt: string;
  authorAccountId: string;
  authorName: string;
};

export async function fetchClassMemos(classId: string): Promise<ScheduleMemo[]> {
  const { data, error } = await supabase
    .from("schedule_memos")
    .select("id, content, created_at, author_account_id, accounts(name)")
    .eq("class_id", classId)
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

export async function createClassMemo(classId: string, content: string): Promise<void> {
  const myAccountId = await getMyAccountId();
  if (!myAccountId) throw new Error("계정을 확인할 수 없어요");
  const { error } = await supabase.from("schedule_memos").insert({
    class_id: classId, content, author_account_id: myAccountId,
  });
  if (error) throw new Error("메모 등록에 실패했어요: " + error.message);
}

export async function updateClassMemo(memoId: string, content: string): Promise<void> {
  const { error } = await supabase.from("schedule_memos").update({ content }).eq("id", memoId);
  if (error) throw new Error("메모 수정에 실패했어요: " + error.message);
}

export async function deleteClassMemo(memoId: string): Promise<void> {
  const { error } = await supabase.from("schedule_memos").delete().eq("id", memoId);
  if (error) throw new Error("메모 삭제에 실패했어요: " + error.message);
}
