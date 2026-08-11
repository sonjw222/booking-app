"use client";

/*
  하단 네비게이션 (모든 회원 화면 공통)
  - 홈 / 예약 / 내 예약 / 알림 / 마이페이지
  - 알림 탭에 안읽음 뱃지 + 실시간 팝업
*/

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchUnreadCount, subscribeNotifications } from "../../lib/notifications";
import { fetchHasUsableMembership, shouldShowMembershipTabs } from "../../lib/navState";
import NotificationToaster from "./NotificationToaster";
import UiIcon from "./UiIcon";

export default function BottomNav() {
  const pathname = usePathname();
  const is = (p: string) => (p === "/" ? pathname === "/" : pathname.startsWith(p));

  const [unread, setUnread] = useState(0);
  // 예약 가능한(usable) 수강권이 있는지 — 없으면 "예약"/"내 예약" 탭을 모두 숨긴다(NAV-001).
  // null = 아직 판단 전(로딩 중). 판단 전에 "있다"고 가정하면 탭이 잠깐 보였다가 사라지는
  // 깜빡임이 생기므로, 로딩 중에는 false와 동일하게 취급해 안정적으로 3탭만 보여준다.
  const [hasUsable, setHasUsable] = useState<boolean | null>(null);
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
    // 페이지 이동마다(구매 후 이동 포함) 새로고침 없이 재확인한다 — BottomNav는 페이지마다
    // 개별적으로 마운트되는 공통 컴포넌트라 pathname 변경 시 이 effect가 다시 실행된다.
    let mounted = true;
    setHasUsable(null); // pathname이 바뀔 때마다 재확인 — 확정 전까지는 다시 로딩 상태로
    fetchHasUsableMembership()
      .then((v) => { if (mounted) setHasUsable(v); })
      .catch(() => { if (mounted) setHasUsable(true); }); // 조회 실패 시 탭을 숨기지 않음(안전 기본값)
    return () => { mounted = false; };
  }, [pathname]);

  const showMembershipTabs = shouldShowMembershipTabs(hasUsable);

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
      <nav className={`bottom-nav ${keyboardOpen ? "keyboard-hidden" : ""}`} aria-label="회원 주요 메뉴">
        <a className={`nav-item ${is("/") ? "active" : ""}`} href="/">
          <div className="nav-icon"><UiIcon name="home" /></div>홈
        </a>
        {showMembershipTabs && (
          <a className={`nav-item ${is("/reservation") ? "active" : ""}`} href="/reservation">
            <div className="nav-icon"><UiIcon name="calendar" /></div>예약
          </a>
        )}
        {showMembershipTabs && (
          <a className={`nav-item ${is("/my-reservations") ? "active" : ""}`} href="/my-reservations">
            <div className="nav-icon"><UiIcon name="list" /></div>내 예약
          </a>
        )}
        <a className={`nav-item ${is("/notifications") ? "active" : ""}`} href="/notifications">
          <div className="nav-icon" style={{ position: "relative" }}>
            <UiIcon name="bell" />
            {unread > 0 && <span className="nav-badge">{unread > 9 ? "9+" : unread}</span>}
          </div>알림
        </a>
        <a className={`nav-item ${is("/mypage") ? "active" : ""}`} href="/mypage">
          <div className="nav-icon"><UiIcon name="user" /></div>마이
        </a>
      </nav>
    </>
  );
}
