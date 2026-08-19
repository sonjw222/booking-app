"use client";

/*
  하단 네비게이션 (모든 회원 화면 공통)
  - 홈 / 예약 / 내 예약 / 알림 / 마이페이지
  - 알림 탭에 안읽음 뱃지 + 실시간 팝업
*/

import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import { fetchUnreadCount, subscribeNotifications } from "../../lib/notifications";
import {
  fetchHasUsableMembership, shouldShowMembershipTabs,
  getCachedHasUsableMembership, setCachedHasUsableMembership,
} from "../../lib/navState";
import NotificationToaster from "./NotificationToaster";
import UiIcon from "./UiIcon";

export default function BottomNav() {
  const pathname = usePathname();
  const is = (p: string) => (p === "/" ? pathname === "/" : pathname.startsWith(p));
  // /mypage/calendar는 마이페이지가 아니라 내 예약(/my-reservations)에서 들어가는 화면이라
  // "마이" 탭이 아닌 "내 예약" 탭이 활성화돼야 한다.
  const isMyReservations = is("/my-reservations") || pathname.startsWith("/mypage/calendar");
  const isMypage = is("/mypage") && !pathname.startsWith("/mypage/calendar");

  const [unread, setUnread] = useState(0);
  // 예약 가능한(usable) 수강권이 있는지 — 없으면 "예약"/"내 예약" 탭을 모두 숨긴다(NAV-001).
  // null = 아직 판단 전(로딩 중). 판단 전에 "있다"고 가정하면 탭이 잠깐 보였다가 사라지는
  // 깜빡임이 생기므로, 로딩 중에는 false와 동일하게 취급해 안정적으로 3탭만 보여준다.
  // 서버 프리렌더와 맞추기 위해 초기값은 null로 두고, 마운트 직후 useLayoutEffect에서
  // 캐시값을 화면에 그려지기 전에 반영한다(아래) — BottomNav가 페이지마다 새로 마운트돼
  // 캐시가 없으면 페이지를 옮길 때마다 3탭→5탭으로 깜빡이는 문제가 있었다.
  const [hasUsable, setHasUsable] = useState<boolean | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useLayoutEffect(() => {
    const cached = getCachedHasUsableMembership();
    if (cached !== null) setHasUsable(cached);
  }, []);

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
    // 위 캐시값(또는 이전 페이지에서 이미 확정된 값)을 화면에 유지한 채 백그라운드로
    // 재확인만 하고, 값이 바뀔 때만 갱신한다 — 매 이동마다 null로 비웠다가 다시 채우면
    // 그 자체로 깜빡임이 생긴다.
    let mounted = true;
    fetchHasUsableMembership()
      .then((v) => { if (mounted) { setHasUsable(v); setCachedHasUsableMembership(v); } })
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
          <a className={`nav-item ${isMyReservations ? "active" : ""}`} href="/my-reservations">
            <div className="nav-icon"><UiIcon name="list" /></div>내 예약
          </a>
        )}
        <a className={`nav-item ${is("/notifications") ? "active" : ""}`} href="/notifications">
          <div className="nav-icon" style={{ position: "relative" }}>
            <UiIcon name="bell" />
            {unread > 0 && <span className="nav-badge">{unread > 9 ? "9+" : unread}</span>}
          </div>알림
        </a>
        <a className={`nav-item ${isMypage ? "active" : ""}`} href="/mypage">
          <div className="nav-icon"><UiIcon name="user" /></div>마이
        </a>
      </nav>
    </>
  );
}
