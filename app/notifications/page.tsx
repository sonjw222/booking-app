"use client";

/*
  회원 알림 화면
  - 공지 / 예약 임박 / 수강권 만료·소진 재등록 등 알림 누적 목록
  - 들어오면 전체 읽음 처리
  - 공지 알림은 눌러서 상세(제목/본문/사진) 확인
  - 재등록 알림은 눌러서 센터로 이동해 바로 결제
*/

import { useEffect, useState } from "react";
import Loading from "../components/Loading";
import BottomNav from "../components/BottomNav";
import { ZoomableImage } from "../components/ImageViewer";
import UiIcon from "../components/UiIcon";
import EmptyState from "../components/EmptyState";
import {
  fetchNotifications, markRead, deleteNotification, notificationHref,
  type Notification,
} from "../../lib/notifications";
import {
  fetchMyAnnouncements, announcementPhotoUrl, type Announcement,
} from "../../lib/announcements";

export default function NotificationsPage() {
  const [list, setList] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [announcements, setAnnouncements] = useState<(Announcement & { centerName: string })[]>([]);
  const [openAnnounce, setOpenAnnounce] = useState<(Announcement & { centerName: string }) | null>(null);

  useEffect(() => {
    (async () => {
      const [ns, ans] = await Promise.all([fetchNotifications(), fetchMyAnnouncements()]);
      setList(ns);
      setAnnouncements(ans);
      setLoading(false);
      // 전체 읽음 처리 (뱃지 제거)
      await markRead();
    })();
  }, []);

  function handleClick(n: Notification) {
    // 공지 알림이면 상세 시트 열기
    if (n.kind === "announcement" && n.data?.announcement_id) {
      const found = announcements.find((a) => a.id === n.data.announcement_id);
      if (found) { setOpenAnnounce(found); return; }
    }
    // 문의 답변 알림은 목록이 아니라 해당 스레드로 바로 이동(NOTIF-001 E-2) — 토스트 팝업과
    // 동일한 판단 로직을 공유한다(notificationHref).
    window.location.href = notificationHref(n);
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await deleteNotification(id);
    setList((prev) => prev.filter((n) => n.id !== id));
  }

  if (loading) return <Loading />;

  return (
    <div className="app-shell member-notifications">
      <div className="noti-head">
        <h1>알림</h1>
        <a href="/settings/notifications">설정</a>
      </div>

      {list.length === 0 ? (
        <EmptyState icon="bell" title="아직 알림이 없어요"
          description="예약과 수강권 소식을 이곳에서 알려드릴게요."
          action={<a className="ghost-btn" href="/reservation">수업 둘러보기</a>} />
      ) : (
        <div className="noti-list">
          {list.map((n) => (
            <div
              key={n.id}
              className={`noti-row ${n.read ? "" : "unread"}`}
              onClick={() => handleClick(n)}
            >
              <span className="noti-emoji"><UiIcon name={n.kind === "announcement" ? "megaphone" : n.kind.includes("reservation") ? "calendar" : n.kind.includes("class") ? "clock" : "ticket"} size={22} /></span>
              <div className="noti-main">
                <div className="noti-title">{n.title}</div>
                <div className="noti-body">{n.body}</div>
                <div className="noti-time">{n.createdAt}</div>
              </div>
              <button className="noti-del" onClick={(e) => handleDelete(n.id, e)}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* 공지 상세 시트 */}
      {openAnnounce && (
        <div className="sheet-overlay" onClick={() => setOpenAnnounce(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="announce-detail-center">{openAnnounce.centerName}</div>
            <div className="sheet-title" style={{ marginTop: 2 }}>{openAnnounce.title}</div>
            <div className="announce-detail-date">{openAnnounce.createdAt}</div>
            <div className="announce-body" style={{ marginTop: 12 }}
              dangerouslySetInnerHTML={{ __html: openAnnounce.body }} />
            {openAnnounce.photos && openAnnounce.photos.length > 0 && (
              <div className="review-photos" style={{ marginTop: 12 }}>
                {openAnnounce.photos.map((ph, i) => (
                  <ZoomableImage
                    key={i} className="review-photo" src={announcementPhotoUrl(ph) ?? ""}
                    group={openAnnounce.photos!.map((p) => announcementPhotoUrl(p) ?? "")} groupIndex={i}
                  />
                ))}
              </div>
            )}
            <button className="ghost-btn" style={{ width: "100%", marginTop: 16 }} onClick={() => setOpenAnnounce(null)}>
              닫기
            </button>
          </div>
        </div>
      )}

      <div style={{ height: 20 }} />
      <BottomNav />
    </div>
  );
}
