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
import {
  fetchNotifications, markRead, deleteNotification,
  type Notification,
} from "../../lib/notifications";
import {
  fetchMyAnnouncements, announcementPhotoUrl, type Announcement,
} from "../../lib/announcements";
import UiIcon from "../components/UiIcon";
import SegmentedTabs from "../components/SegmentedTabs";
import EmptyState from "../components/EmptyState";

export default function NotificationsPage() {
  const [list, setList] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [announcements, setAnnouncements] = useState<(Announcement & { centerName: string })[]>([]);
  const [openAnnounce, setOpenAnnounce] = useState<(Announcement & { centerName: string }) | null>(null);
  const [filter, setFilter] = useState<"all" | "reservation" | "benefit" | "announcement">("all");

  useEffect(() => {
    (async () => {
      const [ns, ans] = await Promise.all([fetchNotifications(), fetchMyAnnouncements()]);
      setList(ns);
      setAnnouncements(ans);
      setLoading(false);
    })();
  }, []);

  async function handleClick(n: Notification) {
    if (!n.read) {
      setList((prev) => prev.map((item) => item.id === n.id ? { ...item, read: true } : item));
      await markRead([n.id]);
    }
    // 공지 알림이면 상세 시트 열기
    if (n.kind === "announcement" && n.data?.announcement_id) {
      const found = announcements.find((a) => a.id === n.data.announcement_id);
      if (found) { setOpenAnnounce(found); return; }
    }
    // 그 외에는 링크로 이동
    if (n.link) window.location.href = n.link;
  }

  async function handleReadAll() {
    setList((prev) => prev.map((item) => ({ ...item, read: true })));
    await markRead();
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await deleteNotification(id);
    setList((prev) => prev.filter((n) => n.id !== id));
  }

  async function handleDeleteMany(ids: string[], e: React.MouseEvent) {
    e.stopPropagation();
    await Promise.all(ids.map((id) => deleteNotification(id)));
    setList((prev) => prev.filter((n) => !ids.includes(n.id)));
  }

  if (loading) return <Loading />;
  const filtered = list.filter((n) => {
    if (filter === "all") return true;
    if (filter === "announcement") return n.kind === "announcement";
    if (filter === "reservation") return n.kind.includes("reservation") || n.kind.includes("class");
    return !n.kind.includes("reservation") && !n.kind.includes("class") && n.kind !== "announcement";
  });
  const groups = (() => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(yesterdayDate);
    const map = new Map<string, Notification[]>();
    for (const n of filtered) {
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(n.createdAtRaw));
      const label = date === today ? "오늘" : date === yesterday ? "어제" : date;
      map.set(label, [...(map.get(label) ?? []), n]);
    }
    return Array.from(map.entries());
  })();

  function priorityOf(kind: string) {
    if (["reservation_today", "waitlist_promoted", "reservation_canceled", "pass_expired"].includes(kind)) return "important";
    return "normal";
  }


  function collapseSimilar(items: Notification[]) {
    const collapsed = new Map<string, { item: Notification; ids: string[] }>();
    for (const item of items) {
      const key = `${item.kind}|${item.title}|${item.body}|${item.link ?? ""}`;
      const current = collapsed.get(key);
      if (current) current.ids.push(item.id);
      else collapsed.set(key, { item, ids: [item.id] });
    }
    return Array.from(collapsed.values());
  }

  return (
    <div className="app-shell member-notifications">
      <div className="noti-head">
        <h1>알림</h1>
        {list.some((item) => !item.read) && <button onClick={handleReadAll}>모두 읽음</button>}
      </div>
      <SegmentedTabs value={filter} onChange={setFilter} label="알림 종류"
        items={[{ value: "all", label: "전체" },{ value: "reservation", label: "예약" },{ value: "benefit", label: "혜택" },{ value: "announcement", label: "공지" }]} />

      {filtered.length === 0 ? (
        <EmptyState icon="bell" title={filter === "all" ? "아직 알림이 없어요" : "이 항목의 알림이 없어요"}
          description="예약과 수강권 소식을 이곳에서 알려드릴게요."
          action={<a className="ghost-btn" href={filter === "all" ? "/reservation" : "/settings/notifications"}>{filter === "all" ? "수업 둘러보기" : "알림 설정 보기"}</a>} />
      ) : (
        <div className="noti-list">
          {groups.map(([label, group]) => <section key={label} className="noti-group">
            <h2>{label}</h2>
          {collapseSimilar(group).map(({ item: n, ids }) => (
            <div
              key={n.id}
              className={`noti-row ${n.read ? "" : "unread"} priority-${priorityOf(n.kind)}`}
              onClick={() => handleClick(n)}
            >
              {!n.read && <span className="noti-unread-dot" aria-label="읽지 않음" />}
              <span className="noti-emoji"><UiIcon name={n.kind === "announcement" ? "megaphone" : n.kind.includes("reservation") ? "calendar" : n.kind.includes("class") ? "clock" : "ticket"} size={22} /></span>
              <div className="noti-main">
                <div className="noti-title">{n.title}</div>
                <div className="noti-body">{n.body}</div>
                <div className="noti-time">{n.createdAt}</div>
              </div>
              {ids.length > 1 && <span className="noti-repeat-count">{ids.length}건</span>}
              <button className="noti-del" onClick={(e) => ids.length > 1 ? handleDeleteMany(ids, e) : handleDelete(n.id, e)}>×</button>
            </div>
          ))}</section>)}
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
                  <img key={i} className="review-photo" src={announcementPhotoUrl(ph) ?? ""} alt="" />
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
