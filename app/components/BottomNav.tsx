"use client";

/*
  하단 네비게이션 (모든 회원 화면 공통)
  - 홈 / 예약 / 내 예약 / 알림 / 마이페이지
  - 알림 탭에 안읽음 뱃지 + 실시간 팝업
*/

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchUnreadCount, subscribeNotifications } from "../../lib/notifications";
import NotificationToaster from "./NotificationToaster";

export default function BottomNav() {
  const pathname = usePathname();
  const is = (p: string) => (p === "/" ? pathname === "/" : pathname.startsWith(p));

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
    if (pathname.startsWith("/notifications")) setUnread(0);
  }, [pathname]);

  return (
    <>
      <NotificationToaster />
      <div className="bottom-nav">
        <a className={`nav-item ${is("/") ? "active" : ""}`} href="/">
          <div className="nav-icon">⌂</div>홈
        </a>
        <a className={`nav-item ${is("/reservation") ? "active" : ""}`} href="/reservation">
          <div className="nav-icon">▤</div>예약
        </a>
        <a className={`nav-item ${is("/my-reservations") ? "active" : ""}`} href="/my-reservations">
          <div className="nav-icon">◑</div>내 예약
        </a>
        <a className={`nav-item ${is("/notifications") ? "active" : ""}`} href="/notifications">
          <div className="nav-icon" style={{ position: "relative" }}>
            🔔
            {unread > 0 && <span className="nav-badge">{unread > 99 ? "99+" : unread}</span>}
          </div>알림
        </a>
        <a className={`nav-item ${is("/mypage") ? "active" : ""}`} href="/mypage">
          <div className="nav-icon">◔</div>마이페이지
        </a>
      </div>
    </>
  );
}
