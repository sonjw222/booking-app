/*
  마케팅 알림(플랫폼 전체 발송) — 운영자 전용
  - 공지사항(center_announcements)과 별개. 센터 단위가 아니라 전체 회원에게 보낸다.
  - 발송은 add_marketing_notifications.sql의 create_marketing_message_safe() RPC가
    등록 + 팬아웃(push_notification)까지 한 트랜잭션으로 처리한다.
*/

import { supabase } from "./supabaseClient";

export type MarketingMessage = {
  id: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  targetCount: number;
};

export async function fetchMarketingMessages(): Promise<MarketingMessage[]> {
  const { data, error } = await supabase
    .from("marketing_messages")
    .select("id, title, body, link, created_at, target_count")
    .order("created_at", { ascending: false });
  if (error) throw new Error("발송 내역을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((m: any) => ({
    id: m.id, title: m.title, body: m.body, link: m.link,
    createdAt: m.created_at, targetCount: m.target_count,
  }));
}

export async function sendMarketingMessage(title: string, body: string, link: string): Promise<string> {
  const { data, error } = await supabase.rpc("create_marketing_message_safe", {
    p_title: title, p_body: body, p_link: link || null,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return data as string;
}
