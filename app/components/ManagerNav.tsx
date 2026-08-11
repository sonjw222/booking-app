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
import UiIcon from "./UiIcon";

export default function ManagerNav() {
  const pathname = usePathname();
  const is = (p: string) => pathname.startsWith(p);
  const isMore = pathname === "/manager";

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
    if (pathname.startsWith("/manager/notifications")) setUnread(0);
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
      <nav className={`bottom-nav ${keyboardOpen ? "keyboard-hidden" : ""}`} aria-label="관리자 주요 메뉴">
        <a className={`nav-item ${is("/manager/classes") ? "active" : ""}`} href="/manager/classes">
          <div className="nav-icon"><UiIcon name="calendar" /></div>수업
        </a>
        <a className={`nav-item ${is("/manager/members") ? "active" : ""}`} href="/manager/members">
          <div className="nav-icon"><UiIcon name="users" /></div>회원
        </a>
        <a className={`nav-item ${is("/manager/notifications") ? "active" : ""}`} href="/manager/notifications">
          <div className="nav-icon" style={{ position: "relative" }}>
            <UiIcon name="bell" />
            {unread > 0 && <span className="nav-badge">{unread > 9 ? "9+" : unread}</span>}
          </div>알림
        </a>
        <a className={`nav-item ${isMore ? "active" : ""}`} href="/manager">
          <div className="nav-icon"><UiIcon name="list" /></div>더보기
        </a>
      </nav>
    </>
  );
}
