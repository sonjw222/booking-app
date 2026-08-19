/*
  상담고객(leads) 관리 — P1-8
  - 등록 전 잠재고객(전화 문의, 방문 상담 등) 기록. 회원(앱 가입+센터 등록) 전 단계.
  - "전환"은 상태만 바꾼다 — leads는 앱 계정과 연결돼 있지 않아 자동으로 center_members를
    만들 수 없다(회원 등록은 앱에 가입한 사람을 이름/전화번호로 찾아 연결하는 기존 흐름,
    app/manager/members/page.tsx 참고). 실제 등록은 그 화면에서 별도로 진행한다.
*/
import { supabase } from "./supabaseClient";

export type LeadStatus = "new" | "contacted" | "converted" | "dropped";

export type Lead = {
  id: string;
  centerId: string;
  name: string;
  phone: string | null;
  channel: string | null;
  status: LeadStatus;
  memo: string | null;
  createdAt: string;
};

function mapRow(r: any): Lead {
  return {
    id: r.id, centerId: r.center_id, name: r.name, phone: r.phone,
    channel: r.channel, status: r.status, memo: r.memo, createdAt: r.created_at,
  };
}

export async function fetchLeads(centerId: string): Promise<Lead[]> {
  const { data, error } = await supabase
    .from("leads")
    .select("id, center_id, name, phone, channel, status, memo, created_at")
    .eq("center_id", centerId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("상담고객 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map(mapRow);
}

export type LeadInput = { name: string; phone: string; channel: string; memo: string };

export async function createLead(centerId: string, input: LeadInput): Promise<void> {
  const { error } = await supabase.from("leads").insert({
    center_id: centerId,
    name: input.name,
    phone: input.phone || null,
    channel: input.channel || null,
    memo: input.memo || null,
  });
  if (error) throw new Error("상담고객 등록에 실패했어요: " + error.message);
}

export async function updateLead(id: string, input: LeadInput): Promise<void> {
  const { error } = await supabase.from("leads").update({
    name: input.name,
    phone: input.phone || null,
    channel: input.channel || null,
    memo: input.memo || null,
  }).eq("id", id);
  if (error) throw new Error("상담고객 정보 수정에 실패했어요: " + error.message);
}

export async function updateLeadStatus(id: string, status: LeadStatus): Promise<void> {
  const { error } = await supabase.from("leads").update({ status }).eq("id", id);
  if (error) throw new Error("상태 변경에 실패했어요: " + error.message);
}

export async function deleteLead(id: string): Promise<void> {
  const { error } = await supabase.from("leads").delete().eq("id", id);
  if (error) throw new Error("상담고객 삭제에 실패했어요: " + error.message);
}
