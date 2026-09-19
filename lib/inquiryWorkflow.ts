import { supabase } from "./supabaseClient";
export type InquiryWorkflow = {
  status: "open" | "in_progress" | "resolved";
  assigneeId: string | null;
  version: number;
  staff: { id: string; name: string }[];
  members: { id: string; name: string }[];
  notes: { id: string; body: string; author: string; createdAt: string }[];
};
export const INQUIRY_STATUSES = { open: "미처리", in_progress: "처리 중", resolved: "처리 완료" } as const;
function workflowError(error: { code?: string; message: string }) {
  return new Error(error.code === "PGRST202" ? "문의 업무 관리 기능의 DB 업데이트가 아직 적용되지 않았습니다. 기존 답변 기능은 사용할 수 있습니다." : error.message);
}
export async function getInquiryWorkflow(threadId: string): Promise<InquiryWorkflow> {
  const { data, error } = await supabase.rpc("get_inquiry_workflow", { p_thread_id: threadId });
  if (error) throw workflowError(error);
  return data as InquiryWorkflow;
}
export async function saveInquiryWorkflow(threadId: string, input: Pick<InquiryWorkflow,"status"|"assigneeId"|"version">, note: string): Promise<InquiryWorkflow> {
  const { data, error } = await supabase.rpc("save_inquiry_workflow", { p_thread_id: threadId, p_status: input.status, p_assignee_id: input.assigneeId, p_version: input.version, p_note: note });
  if (error) throw workflowError(error);
  return data as InquiryWorkflow;
}
