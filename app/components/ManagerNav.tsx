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
  const canSee = (permissionKey: string) => canSeeManagerMenu(isOwner, myPerms, permissionKey);

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
      <aside className="workspace-sidebar manager-sidebar" aria-label="센터 관리자 메뉴">
        <a className="desktop-brand" href="/manager">
          <span className="desktop-brand-mark">M</span>
          <span><b>모하빗</b><small>센터 관리자</small></span>
        </a>
        <div className="workspace-sidebar-scroll">
          <div className="desktop-nav-section">업무</div>
          <a className={`desktop-nav-item ${pathname === "/manager" ? "active" : ""}`} href="/manager"><UiIcon name="grid" /><span>대시보드</span></a>
          <Link className={`desktop-nav-item ${is("/manager/classes") ? "active" : ""}`} href="/manager/classes" replace><UiIcon name="calendar" /><span>수업·예약</span></Link>
          {canSeeMembers && <Link className={`desktop-nav-item ${is("/manager/members") ? "active" : ""}`} href="/manager/members" replace><UiIcon name="users" /><span>회원</span></Link>}
          <Link className={`desktop-nav-item ${is("/manager/notifications") ? "active" : ""}`} href="/manager/notifications" replace>
            <UiIcon name="bell" /><span>알림</span>{unread > 0 && <span className="desktop-nav-badge">{unread > 99 ? "99+" : unread}</span>}
          </Link>
          {canSee("pass.sales.view") && <a className={`desktop-nav-item ${is("/manager/sales") ? "active" : ""}`} href="/manager/sales"><UiIcon name="receipt" /><span>매출·결제</span></a>}

          <div className="desktop-nav-section">고객 관리</div>
          {canSee("customer.lead.view") && <a className={`desktop-nav-item ${is("/manager/leads") ? "active" : ""}`} href="/manager/leads"><UiIcon name="message" /><span>상담고객</span></a>}
          {canSee("customer.progress") && <a className={`desktop-nav-item ${is("/manager/progress") ? "active" : ""}`} href="/manager/progress/record"><UiIcon name="edit" /><span>진도 기록</span></a>}
          {canSee("message.alimtalk.view") && <a className={`desktop-nav-item ${is("/manager/alimtalk") ? "active" : ""}`} href="/manager/alimtalk"><UiIcon name="megaphone" /><span>알림톡</span></a>}
          {canSee("pass.order.view") && <a className={`desktop-nav-item ${is("/manager/orders") ? "active" : ""}`} href="/manager/orders"><UiIcon name="cart" /><span>주문</span></a>}
          {canSee("board.notice.view") && <a className={`desktop-nav-item ${is("/manager/announcements") ? "active" : ""}`} href="/manager/announcements"><UiIcon name="megaphone" /><span>공지사항</span></a>}
          {canSee("board.inquiry.view") && <a className={`desktop-nav-item ${is("/manager/inquiries") ? "active" : ""}`} href="/manager/inquiries"><UiIcon name="message" /><span>1:1 문의</span></a>}
          {canSee("facility.review.view") && <a className={`desktop-nav-item ${is("/manager/reviews") ? "active" : ""}`} href="/manager/reviews"><UiIcon name="star" /><span>후기</span></a>}

          <div className="desktop-nav-section">센터 설정</div>
          {(canSee("pass.create") || canSee("pass.update")) && <a className={`desktop-nav-item ${is("/manager/membership-rules") ? "active" : ""}`} href="/manager/membership-rules"><UiIcon name="ticket" /><span>수강권</span></a>}
          {canSee("pass.goods.view") && <a className={`desktop-nav-item ${is("/manager/goods") ? "active" : ""}`} href="/manager/goods"><UiIcon name="receipt" /><span>상품</span></a>}
          {canSee("facility.staff.view") && <a className={`desktop-nav-item ${is("/manager/staff") ? "active" : ""}`} href="/manager/staff"><UiIcon name="shield" /><span>스태프·권한</span></a>}
          {canSee("facility.info") && <a className={`desktop-nav-item ${is("/manager/center-info") ? "active" : ""}`} href="/manager/center-info"><UiIcon name="building" /><span>센터 정보</span></a>}
          {canSee("facility.room") && <a className={`desktop-nav-item ${is("/manager/rooms") ? "active" : ""}`} href="/manager/rooms"><UiIcon name="building" /><span>룸 관리</span></a>}
          {canSee("facility.operation") && <a className={`desktop-nav-item ${is("/manager/settings") ? "active" : ""}`} href="/manager/settings"><UiIcon name="settings" /><span>운영 설정</span></a>}
          {isOwner && <a className={`desktop-nav-item ${is("/manager/subscription") ? "active" : ""}`} href="/manager/subscription"><UiIcon name="card" /><span>플랫폼 구독</span></a>}
          {isOwner && <a className={`desktop-nav-item ${is("/manager/settlement") ? "active" : ""}`} href="/manager/settlement"><UiIcon name="bank" /><span>정산계좌</span></a>}
        </div>
        <a className="workspace-sidebar-mode" href="/"><UiIcon name="user" /><span>회원 화면으로 전환</span></a>
      </aside>
      {/* 릴리스 폴리시 배치 6차(2026-09-15) — BottomNav와 동일한 이유로 replace(주석은
          BottomNav.tsx 참고). */}
      <nav className={`bottom-nav ${keyboardOpen ? "keyboard-hidden" : ""}`} aria-label="관리자 주요 메뉴">
        <Link className={`nav-item ${is("/manager/classes") ? "active" : ""}`} href="/manager/classes" replace>
          <div className="nav-icon"><UiIcon name="calendar" /></div>수업
        </Link>
        {canSeeMembers && (
          <Link className={`nav-item ${is("/manager/members") ? "active" : ""}`} href="/manager/members" replace>
            <div className="nav-icon"><UiIcon name="users" /></div>회원
          </Link>
        )}
        <Link className={`nav-item ${is("/manager/notifications") ? "active" : ""}`} href="/manager/notifications" replace>
          <div className="nav-icon" style={{ position: "relative" }}>
            <UiIcon name="bell" />
            {unread > 0 && <span className="nav-badge">{unread > 9 ? "9+" : unread}</span>}
          </div>알림
        </Link>
        <Link className={`nav-item ${isMore ? "active" : ""}`} href="/manager" replace>
          <div className="nav-icon"><UiIcon name="list" /></div>더보기
        </Link>
      </nav>
    </>
  );
}
