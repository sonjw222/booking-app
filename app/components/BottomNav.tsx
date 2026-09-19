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
import UiIcon from "./UiIcon";

export default function BottomNav() {
  const pathname = usePathname();
  const is = (p: string) => (p === "/" ? pathname === "/" : pathname.startsWith(p));

  const [unread, setUnread] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

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

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const check = () => setKeyboardOpen(window.innerHeight - viewport.height > 140);
    viewport.addEventListener("resize", check);
    viewport.addEventListener("scroll", check);
    check();
    return () => {
      viewport.removeEventListener("resize", check);
      viewport.removeEventListener("scroll", check);
    };
  }, []);

  return (
    <>
      <NotificationToaster />
      <div className={`bottom-nav ${keyboardOpen ? "keyboard-hidden" : ""}`}>
        <a className={`nav-item ${is("/") ? "active" : ""}`} href="/">
          <div className="nav-icon"><UiIcon name="home" /></div>홈
        </a>
        <a className={`nav-item ${is("/reservation") ? "active" : ""}`} href="/reservation">
          <div className="nav-icon"><UiIcon name="calendar" /></div>예약
        </a>
        <a className={`nav-item ${is("/my-reservations") ? "active" : ""}`} href="/my-reservations">
          <div className="nav-icon"><UiIcon name="list" /></div>내 예약
        </a>
        <a className={`nav-item ${is("/notifications") ? "active" : ""}`} href="/notifications">
          <div className="nav-icon" style={{ position: "relative" }}>
            <UiIcon name="bell" />
            {unread > 0 && <span className="nav-badge">{unread > 9 ? "9+" : unread}</span>}
          </div>알림
        </a>
        <a className={`nav-item ${is("/mypage") ? "active" : ""}`} href="/mypage">
          <div className="nav-icon"><UiIcon name="user" /></div>마이
        </a>
      </div>
    </>
  );
}
