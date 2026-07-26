"use client";

/*
  관리자 모드 하단 네비게이션
  - 일정 / 회원 / 알림 / 더보기
  - 알림 탭에 안읽음 뱃지 + 실시간 팝업
*/

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchUnreadCount, subscribeNotifications } from "../../lib/notifications";
import NotificationToaster from "./NotificationToaster";

export default function ManagerNav() {
  const pathname = usePathname();
  const is = (p: string) => pathname.startsWith(p);
  const isMore = pathname === "/manager";

  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let mounted = true;
    let unsub: (() => void) | null = null;

    fetchUnreadCount().then((n) => { if (mounted) setUnread(n); });

    subscribeNotifications(() => {
      if (mounted) setUnread((prev) => prev + 1);
    }).then((fn) => { unsub = fn; });

    return () => { mounted = false; if (unsub) unsub(); };
  }, []);

  useEffect(() => {
    if (pathname.startsWith("/manager/notifications")) setUnread(0);
  }, [pathname]);

  return (
    <>
      <NotificationToaster />
      <div className="bottom-nav">
        <a className={`nav-item ${is("/manager/classes") ? "active" : ""}`} href="/manager/classes">
          <div className="nav-icon">▤</div>수업
        </a>
        <a className={`nav-item ${is("/manager/members") ? "active" : ""}`} href="/manager/members">
          <div className="nav-icon">◍</div>회원
        </a>
        <a className={`nav-item ${is("/manager/notifications") ? "active" : ""}`} href="/manager/notifications">
          <div className="nav-icon" style={{ position: "relative" }}>
            🔔
            {unread > 0 && <span className="nav-badge">{unread > 99 ? "99+" : unread}</span>}
          </div>알림
        </a>
        <a className={`nav-item ${isMore ? "active" : ""}`} href="/manager">
          <div className="nav-icon">≡</div>더보기
        </a>
      </div>
    </>
  );
}
