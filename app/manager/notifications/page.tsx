"use client";

/*
  관리자 알림 화면
  - 신규 구매 / 신규 후기 / 신규 예약·취소 등 알림 누적
  - 들어오면 전체 읽음 처리
  - 누르면 해당 관리 화면으로 이동
*/

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Loading from "../../components/Loading";
import ManagerNav from "../../components/ManagerNav";
import {
  fetchNotifications, markRead, deleteNotification, notiEmoji, notificationHref,
  type Notification,
} from "../../../lib/notifications";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";

export default function ManagerNotificationsPage() {
  const router = useRouter();
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [list, setList] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const myCenters = await fetchMyCenters();
      setCenters(myCenters);
      if (myCenters.length > 0) {
        const ns = await fetchNotifications();
        setList(ns);
        await markRead();
      }
      setLoading(false);
    })();
  }, []);

  function handleClick(n: Notification) {
    // 신규 문의 알림은 목록이 아니라 해당 스레드로 바로 이동(NOTIF-001 E-2) — 토스트 팝업과
    // 동일한 판단 로직을 공유한다(notificationHref).
    router.push(notificationHref(n));
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await deleteNotification(id);
    setList((prev) => prev.filter((n) => n.id !== id));
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="header">
          <div className="title" style={{ fontSize: 20, fontWeight: 800 }}>알림</div>
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
        <ManagerNav />
      </div>
    );
  }

  if (loading) return <Loading />;

  return (
    <div className="app-shell">
      <div className="header">
        <div className="title" style={{ fontSize: 20, fontWeight: 800 }}>알림</div>
      </div>

      {list.length === 0 ? (
        <div className="empty-note" style={{ padding: "50px 20px", textAlign: "center", color: "var(--text-dim)" }}>
          아직 알림이 없어요.
        </div>
      ) : (
        <div className="noti-list">
          {list.map((n) => (
            <div
              key={n.id}
              className={`noti-row ${n.read ? "" : "unread"}`}
              onClick={() => handleClick(n)}
            >
              <span className="noti-emoji">{notiEmoji(n.kind)}</span>
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

      <div style={{ height: 20 }} />
      <ManagerNav />
    </div>
  );
}
