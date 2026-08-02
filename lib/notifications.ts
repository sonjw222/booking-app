/*
  알림
  - 내 알림 목록 조회 / 안읽음 개수 / 읽음 처리
  - 실시간 구독 (Supabase Realtime) → 새 알림 팝업
  - 공지, 예약 임박, 수강권 만료·소진, (매니저) 신규구매·신규후기 등
*/

import { supabase } from "./supabaseClient";

const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});

export type NotiKind =
  | "announcement"
  | "pass_expired" | "pass_used_up"
  | "reservation_3days" | "reservation_today"
  | "reservation_confirmed" | "reservation_waitlisted" | "waitlist_promoted"
  | "new_order" | "new_review" | "new_reservation" | "reservation_canceled" | "no_show"
  | "new_inquiry" | "inquiry_reply"
  | string;

export type Notification = {
  id: string;
  kind: NotiKind;
  title: string;
  body: string;
  centerId: string | null;
  link: string | null;
  data: any;
  read: boolean;
  createdAt: string;
  createdAtRaw: string;
};

// 문의 관련 알림(new_inquiry/inquiry_reply)은 목록 화면이 아니라 해당 스레드로 바로 열려야
// 한다(NOTIF-001 E-2) — 이 판단을 회원 알림 목록/매니저 알림 목록/실시간 토스트 팝업 3곳이
// 각자 구현하다 보니 토스트 팝업(NotificationToaster)에서 이 분기가 통째로 빠져 있었던 게
// 실브라우저 QA에서 드러난 실제 원인이었다 — 한 곳에서만 계산하도록 모아 재발을 막는다.
const THREAD_LINK_KINDS = new Set(["new_inquiry", "inquiry_reply"]);

export function notificationHref(n: Pick<Notification, "kind" | "link" | "data">): string {
  if (THREAD_LINK_KINDS.has(n.kind) && n.link && n.data?.thread_id) {
    return `${n.link}?thread=${n.data.thread_id}`;
  }
  return n.link ?? "/notifications";
}

function mapRow(r: any): Notification {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body ?? "",
    centerId: r.center_id ?? null,
    link: r.link ?? null,
    data: r.data ?? null,
    read: !!r.read_at,
    createdAt: KST.format(new Date(r.created_at)),
    createdAtRaw: r.created_at,
  };
}

// 아이콘 (kind별)
export function notiEmoji(kind: NotiKind): string {
  switch (kind) {
    case "announcement": return "📢";
    case "pass_expired": return "⏰";
    case "pass_used_up": return "🎫";
    case "reservation_3days": return "🗓️";
    case "reservation_today": return "🔔";
    case "new_order": return "🧾";
    case "new_review": return "⭐";
    case "new_reservation": return "✅";
    case "reservation_confirmed": return "✅";
    case "reservation_waitlisted": return "⏳";
    case "waitlist_promoted": return "🎉";
    case "reservation_canceled": return "❌";
    case "no_show": return "🚫";
    case "new_inquiry": return "💬";
    case "inquiry_reply": return "💬";
    default: return "🔔";
  }
}

// 내 알림 목록
export async function fetchNotifications(limit = 100): Promise<Notification[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, kind, title, body, center_id, link, data, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []).map(mapRow);
}

// 안읽은 개수 (뱃지용)
export async function fetchUnreadCount(): Promise<number> {
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);
  if (error) return 0;
  return count ?? 0;
}

// 읽음 처리 (ids 없으면 전체)
export async function markRead(ids?: string[]): Promise<void> {
  const { error } = await supabase.rpc("mark_notifications_read", {
    p_ids: ids && ids.length > 0 ? ids : null,
  });
  if (error) { /* 조용히 무시 */ }
}

// 알림 삭제
export async function deleteNotification(id: string): Promise<void> {
  await supabase.from("notifications").delete().eq("id", id);
}

/*
  실시간 구독
  - 내 계정으로 새 알림이 insert 되면 콜백 호출 → 팝업 표시
  - 반환된 unsubscribe()를 컴포넌트 언마운트 시 호출
*/
export async function subscribeNotifications(
  onNew: (n: Notification) => void
): Promise<() => void> {
  const { data: authData } = await supabase.auth.getUser();
  const authUser = authData.user;
  if (!authUser) return () => {};

  // 내 account_id 조회 (필터에 사용)
  const { data: acc } = await supabase
    .from("accounts").select("id").eq("auth_id", authUser.id).single();
  const accountId = acc?.id;
  if (!accountId) return () => {};

  // 채널 이름을 매번 고유하게 (여러 컴포넌트에서 동시에 구독해도 충돌 안 나게)
  const uniq = Math.random().toString(36).slice(2);
  const channel = supabase
    .channel(`noti-${accountId}-${uniq}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: `recipient_account_id=eq.${accountId}`,
      },
      (payload) => {
        onNew(mapRow(payload.new));
      }
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}
