"use client";

/*
  관리자 모드 하단 네비게이션
  - 일정 / 회원 / 알림 / 더보기
  - 알림 탭에 안읽음 뱃지 + 실시간 팝업
*/

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchUnreadCount, subscribeNotifications } from "../../lib/notifications";
import { fetchMyCenters } from "../../lib/manager";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../lib/roles";
import NotificationToaster from "./NotificationToaster";
import UiIcon from "./UiIcon";

export default function ManagerNav() {
  const pathname = usePathname();
  const is = (p: string) => pathname.startsWith(p);
  const isMore = pathname === "/manager";

  const [unread, setUnread] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // P1-5: "회원" 탭은 customer.member.view 권한으로 가린다("수업"/"알림"은 본인 일정·본인
  // 알림함이라 권한 카탈로그에 애초에 대응 키가 없음 — schema.sql 참고, 의도적으로 그대로
  // 둠). app/manager/page.tsx의 메뉴 노출 계산과 동일한 패턴(오너는 전권, 로딩 중엔 숨김).
  const [isOwner, setIsOwner] = useState(false);
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchMyCenters()
      .then((centers) => {
        if (cancelled || centers.length === 0) return;
        const active = centers[0];
        setIsOwner(active.isOwner);
        if (active.isOwner) return;
        return fetchMyEffectivePermissionKeys(active.managerCenterId, active.roleId).then((keys) => {
          if (!cancelled) setMyPerms(keys);
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const canSeeMembers = canSeeManagerMenu(isOwner, myPerms, "customer.member.view");

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
        {canSeeMembers && (
          <a className={`nav-item ${is("/manager/members") ? "active" : ""}`} href="/manager/members">
            <div className="nav-icon"><UiIcon name="users" /></div>회원
          </a>
        )}
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
