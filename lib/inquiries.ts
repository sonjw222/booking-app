/*
  1:1 문의 (회원 ↔ 센터 채팅)
  - 회원: 문의할 센터 선택 → 문의방 → 메시지(글/사진) 주고받기
  - 매니저: 자기 센터로 온 문의 목록 → 답변
  - 실시간: inquiry_messages 구독
*/

import { supabase } from "./supabaseClient";

const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});

export type InquiryThread = {
  id: string;
  centerId: string;
  centerName: string;
  memberAccountId: string;
  memberName?: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unread: number;
};

export type InquiryMessage = {
  id: string;
  threadId: string;
  senderRole: "member" | "manager";
  body: string;
  photos: string[] | null;
  createdAt: string;
  createdAtRaw: string;
  mine?: boolean;
};

// ── 회원: 문의 가능한 센터 목록 (수강권 보유 센터 우선 + 승인 센터) ──
export type SelectableCenter = { id: string; name: string };

export async function fetchInquiryCenters(): Promise<SelectableCenter[]> {
  // 내 수강권이 있는 센터
  const { data: mine } = await supabase
    .from("memberships")
    .select("center_id, centers(name)")
    .in("profile_id", (await myProfileIds()));
  const seen = new Set<string>();
  const result: SelectableCenter[] = [];
  for (const r of (mine ?? []) as any[]) {
    if (r.center_id && !seen.has(r.center_id)) {
      seen.add(r.center_id);
      result.push({ id: r.center_id, name: r.centers?.name ?? "센터" });
    }
  }
  return result;
}

async function myProfileIds(): Promise<string[]> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return [];
  const { data: acc } = await supabase.from("accounts").select("id").eq("auth_id", authData.user.id).single();
  if (!acc) return [];
  const { data: profs } = await supabase.from("profiles").select("id").eq("account_id", acc.id).is("deleted_at", null);
  return (profs ?? []).map((p: any) => p.id);
}

// 승인된 센터 검색 (문의할 센터를 자유롭게 고를 때)
export async function searchCentersForInquiry(keyword: string): Promise<SelectableCenter[]> {
  let q = supabase.from("centers").select("id, name").eq("status", "approved").limit(20);
  if (keyword.trim()) q = q.ilike("name", `%${keyword.trim()}%`);
  const { data } = await q;
  return (data ?? []).map((c: any) => ({ id: c.id, name: c.name }));
}

// ── 회원: 문의방 열기 (없으면 생성) ──
export async function openThread(centerId: string): Promise<string> {
  const { data, error } = await supabase.rpc("open_inquiry_thread", { p_center_id: centerId });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return data as string;
}

// ── 회원: 내 문의방 목록 ──
export async function fetchMyThreads(): Promise<InquiryThread[]> {
  const { data, error } = await supabase
    .from("inquiry_threads")
    .select("id, center_id, member_account_id, last_message, last_message_at, member_unread, centers(name)")
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (error) return [];
  return (data ?? []).map((r: any) => ({
    id: r.id,
    centerId: r.center_id,
    centerName: r.centers?.name ?? "센터",
    memberAccountId: r.member_account_id,
    lastMessage: r.last_message,
    lastMessageAt: r.last_message_at ? KST.format(new Date(r.last_message_at)) : null,
    unread: r.member_unread ?? 0,
  }));
}

// ── 매니저: 자기 센터로 온 문의방 목록 ──
export async function fetchCenterThreads(): Promise<InquiryThread[]> {
  const { data, error } = await supabase
    .from("inquiry_threads")
    .select(
      "id, center_id, member_account_id, last_message, last_message_at, manager_unread, centers(name), " +
      "accounts:member_account_id(name, profiles(nickname, name, is_primary))"
    )
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (error) return [];
  return (data ?? []).map((r: any) => ({
    id: r.id,
    centerId: r.center_id,
    centerName: r.centers?.name ?? "센터",
    memberAccountId: r.member_account_id,
    memberName: resolveMemberName(r.accounts),
    lastMessage: r.last_message,
    lastMessageAt: r.last_message_at ? KST.format(new Date(r.last_message_at)) : null,
    unread: r.manager_unread ?? 0,
  }));
}

// 문의방의 회원 표시 이름: 대표 프로필의 nickname → name → 계정 이름 → "회원" 순으로 폴백한다
// (기존 알림 트리거의 coalesce(nickname, name, '회원') 우선순위와 동일하게 맞춤). 회원 계정이
// center_members로 등록돼 있지 않아 RLS상 accounts 조회가 막히는 경우 accounts 자체가
// null로 온다 — 그 경우에도 "회원"으로 안전하게 표시한다(export해 단위 테스트).
export function resolveMemberName(accounts: {
  name?: string | null;
  profiles?: { nickname?: string | null; name?: string | null; is_primary?: boolean }[] | null;
} | null | undefined): string {
  if (!accounts) return "회원";
  const primary = accounts.profiles?.find((p) => p.is_primary) ?? accounts.profiles?.[0];
  return primary?.nickname || primary?.name || accounts.name || "회원";
}

// ── 메시지 목록 ──
export async function fetchMessages(threadId: string): Promise<InquiryMessage[]> {
  const { data: authData } = await supabase.auth.getUser();
  let myAccountId: string | null = null;
  if (authData.user) {
    const { data: acc } = await supabase.from("accounts").select("id").eq("auth_id", authData.user.id).single();
    myAccountId = acc?.id ?? null;
  }
  const { data, error } = await supabase
    .from("inquiry_messages")
    .select("id, thread_id, sender_account_id, sender_role, body, photos, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  if (error) throw new Error("메시지를 불러오지 못했어요: " + error.message);
  return (data ?? []).map((m: any) => ({
    id: m.id,
    threadId: m.thread_id,
    senderRole: m.sender_role,
    body: m.body ?? "",
    photos: m.photos ?? null,
    createdAt: KST.format(new Date(m.created_at)),
    createdAtRaw: m.created_at,
    mine: myAccountId != null && m.sender_account_id === myAccountId,
  }));
}

// ── 메시지 전송 ──
export async function sendMessage(threadId: string, body: string, photos?: string[]): Promise<void> {
  const { error } = await supabase.rpc("send_inquiry_message", {
    p_thread_id: threadId,
    p_body: body,
    p_photos: photos && photos.length > 0 ? photos : null,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

// ── 읽음 처리 ──
export async function readThread(threadId: string): Promise<void> {
  await supabase.rpc("read_inquiry_thread", { p_thread_id: threadId });
}

// ── 실시간 구독 (해당 방에 새 메시지) ──
export function subscribeMessages(threadId: string, onNew: () => void): () => void {
  const uniq = Math.random().toString(36).slice(2);
  const channel = supabase
    .channel(`inquiry-${threadId}-${uniq}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "inquiry_messages", filter: `thread_id=eq.${threadId}` },
      () => onNew()
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

// ── 사진 업로드 (avatars 버킷 재사용) ──
export async function uploadInquiryPhoto(file: File): Promise<string> {
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `inquiries/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file, { upsert: true });
  if (error) throw new Error("사진 업로드에 실패했어요: " + error.message);
  return path;
}

export function inquiryPhotoUrl(path: string | null): string | null {
  if (!path) return null;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return data.publicUrl;
}
