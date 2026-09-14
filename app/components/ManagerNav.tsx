"use client";

/*
  관리자 모드 하단 네비게이션
  - 일정 / 회원 / 알림 / 더보기
  - 알림 탭에 안읽음 뱃지 + 실시간 팝업
*/

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchUnreadCount, subscribeNotifications } from "../../lib/notifications";
import { fetchMyCenters } from "../../lib/manager";
import {
  fetchMyEffectivePermissionKeys, canSeeManagerMenu,
  setCachedCanSeeMembers,
} from "../../lib/roles";
import NotificationToaster from "./NotificationToaster";
import UiIcon from "./UiIcon";

export default function ManagerNav({ initialCanSeeMembers = null }: { initialCanSeeMembers?: boolean | null }) {
  const pathname = usePathname();
  const is = (p: string) => pathname.startsWith(p);
  const isMore = pathname === "/manager";

  const [unread, setUnread] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // P1-5: "회원" 탭은 customer.member.view 권한으로 가린다("수업"/"알림"은 본인 일정·본인
  // 알림함이라 권한 카탈로그에 애초에 대응 키가 없음 — schema.sql 참고, 의도적으로 그대로
  // 둠). app/manager/page.tsx의 메뉴 노출 계산과 동일한 패턴(오너는 전권, 로딩 중엔 숨김).
  // initialCanSeeMembers는 app/manager/layout.tsx(서버 컴포넌트)가 쿠키(lib/roles.ts)를
  // 읽어 내려주는 값으로, 관리자 영역에 처음 들어올 때(새로고침/딥링크 등) 서버 렌더링
  // 시점부터 이미 맞는 탭 개수로 그려지게 해 "탭 3개→4개" 깜빡임을 막는다.
  const [isOwner, setIsOwner] = useState(false);
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);
  const [resolved, setResolved] = useState(false);
  const [cachedCanSeeMembers] = useState<boolean | null>(initialCanSeeMembers);

  // 릴리스 폴리시 배치(2026-09-14, 3차) — 관리자 탭도 <a href>에서 <Link>로 바꿔(아래
  // JSX) 전체 페이지 재로드 없이 전환되므로, 이 nav 자체는 이제 관리자 영역에 있는 동안
  // 계속 마운트된 채 유지된다("ManagerNav는 layout에서 한 번만 마운트"라는 예전 주석이
  // 실제로 성립하게 됨). 권한이 세션 중간에 바뀌는 경우(드물지만 관리자가 스태프 권한을
  // 바꾸는 등)까지 계속 최신으로 반영되도록, deps를 []에서 [pathname]으로 바꿔 "관리자
  // 영역 안에서 탭을 옮길 때마다" 재확인한다 — 예전(매번 전체 리로드)과 재확인 빈도는
  // 동일하게 유지하면서 리로드 비용만 없앤다. 실제 데이터 접근 통제는 어차피 RLS가
  // 최종적으로 막으므로(이 탭 노출은 UX 힌트일 뿐), 마운트를 유지해도 보안 경계 자체는
  // 그대로다.
  useEffect(() => {
    let cancelled = false;
    fetchMyCenters()
      .then((centers) => {
        if (cancelled || centers.length === 0) { setResolved(true); return; }
        const active = centers[0];
        setIsOwner(active.isOwner);
        if (active.isOwner) { setResolved(true); return; }
        return fetchMyEffectivePermissionKeys(active.managerCenterId, active.roleId).then((keys) => {
          if (!cancelled) { setMyPerms(keys); setResolved(true); }
        });
      })
      .catch(() => { if (!cancelled) setResolved(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const liveCanSeeMembers = canSeeManagerMenu(isOwner, myPerms, "customer.member.view");
  useEffect(() => {
    if (resolved) setCachedCanSeeMembers(liveCanSeeMembers);
  }, [resolved, liveCanSeeMembers]);
  const canSeeMembers = resolved ? liveCanSeeMembers : (cachedCanSeeMembers ?? false);

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
        <Link className={`nav-item ${is("/manager/classes") ? "active" : ""}`} href="/manager/classes">
          <div className="nav-icon"><UiIcon name="calendar" /></div>수업
        </Link>
        {canSeeMembers && (
          <Link className={`nav-item ${is("/manager/members") ? "active" : ""}`} href="/manager/members">
            <div className="nav-icon"><UiIcon name="users" /></div>회원
          </Link>
        )}
        <Link className={`nav-item ${is("/manager/notifications") ? "active" : ""}`} href="/manager/notifications">
          <div className="nav-icon" style={{ position: "relative" }}>
            <UiIcon name="bell" />
            {unread > 0 && <span className="nav-badge">{unread > 9 ? "9+" : unread}</span>}
          </div>알림
        </Link>
        <Link className={`nav-item ${isMore ? "active" : ""}`} href="/manager">
          <div className="nav-icon"><UiIcon name="list" /></div>더보기
        </Link>
      </nav>
    </>
  );
}
