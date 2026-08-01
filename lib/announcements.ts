/*
  센터 공지사항
  - 매니저가 작성 (제목 + 내용 HTML + 사진)
  - 회원은 관계된 센터의 공지 열람
  - 새 공지 작성 시 회원에게 알림 발송 (create_announcement RPC 안에서 처리)
*/

import { supabase } from "./supabaseClient";
import { sanitizeRichText } from "./security";

const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "2-digit", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});

export type Announcement = {
  id: string;
  centerId: string;
  title: string;
  body: string;         // HTML
  photos: string[] | null;
  pinned: boolean;
  createdAt: string;
};

function mapRow(r: any): Announcement {
  return {
    id: r.id,
    centerId: r.center_id,
    title: r.title,
    body: r.body ?? "",
    photos: r.photos ?? null,
    pinned: !!r.pinned,
    createdAt: KST.format(new Date(r.created_at)),
  };
}

// 회원: 내가 관계된 센터의 공지 (여러 센터 통합) — 알림 탭 공지 목록용
export async function fetchMyAnnouncements(): Promise<(Announcement & { centerName: string })[]> {
  const { data, error } = await supabase
    .from("center_announcements")
    .select("id, center_id, title, body, photos, pinned, created_at, centers(name)")
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return [];
  return (data ?? []).map((r: any) => ({ ...mapRow(r), centerName: r.centers?.name ?? "센터" }));
}

// 특정 센터 공지 목록
export async function fetchCenterAnnouncements(centerId: string): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from("center_announcements")
    .select("id, center_id, title, body, photos, pinned, created_at")
    .eq("center_id", centerId)
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error("공지를 불러오지 못했어요: " + error.message);
  return (data ?? []).map(mapRow);
}

// 매니저: 공지 작성 (알림 발송 포함)
export async function createAnnouncement(
  centerId: string, title: string, body: string, photos?: string[], pinned = false
): Promise<void> {
  const { error } = await supabase.rpc("create_announcement", {
    p_center_id: centerId,
    p_title: title,
    p_body: sanitizeRichText(body),
    p_photos: photos && photos.length > 0 ? photos : null,
    p_pinned: pinned,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

// 매니저: 공지 수정
export async function updateAnnouncement(
  id: string, title: string, body: string, photos?: string[], pinned = false
): Promise<void> {
  const { error } = await supabase
    .from("center_announcements")
    .update({
      title, body: sanitizeRichText(body),
      photos: photos && photos.length > 0 ? photos : null,
      pinned, updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error("공지 수정에 실패했어요: " + error.message);
}

// 매니저: 공지 삭제
export async function deleteAnnouncement(id: string): Promise<void> {
  const { error } = await supabase.from("center_announcements").delete().eq("id", id);
  if (error) throw new Error("공지 삭제에 실패했어요: " + error.message);
}

// 공지 사진 업로드 (avatars 버킷 재사용 — reviews와 동일 방식)
export async function uploadAnnouncementPhoto(file: File): Promise<string> {
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `announcements/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file, { upsert: true });
  if (error) throw new Error("사진 업로드에 실패했어요: " + error.message);
  return path;
}

export function announcementPhotoUrl(path: string | null): string | null {
  if (!path) return null;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return data.publicUrl;
}
