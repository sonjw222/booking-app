"use client";

/*
  관리자 모드 하단 네비게이션
  - 일정 / 회원 / 알림 / 더보기
  - 알림 탭에 안읽음 뱃지 + 실시간 팝업
*/

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchUnreadCount, subscribeNotifications } from "../../lib/notifications";
import { fetchMyCenters } from "../../lib/manager";
import {
  fetchMyEffectivePermissionKeys, canSeeManagerMenu,
  setCachedCanSeeMembers, setCachedManagerNavState,
  type ManagerNavCachedState,
} from "../../lib/roles";
import { replaceTabNavigation } from "../../lib/navState";
import NotificationToaster from "./NotificationToaster";
import UiIcon from "./UiIcon";
import { useExpandableNavRail } from "./useExpandableNavRail";

const NAV_PERM_RECHECK_MS = 60_000;

export default function ManagerNav({
  initialCanSeeMembers = null, initialNavState = null,
}: {
  initialCanSeeMembers?: boolean | null;
  initialNavState?: ManagerNavCachedState | null;
}) {
  const pathname = usePathname();
  const is = (p: string) => pathname.startsWith(p);
  const isMore = pathname === "/manager";

  const [unread, setUnread] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // P1-5: "회원" 탭은 customer.member.view 권한으로 가린다("수업"/"알림"은 본인 일정·본인
  // 알림함이라 권한 카탈로그에 애초에 대응 키가 없음 — schema.sql 참고, 의도적으로 그대로
  // 둠). app/manager/page.tsx의 메뉴 노출 계산과 동일한 패턴(오너는 전권, 로딩 중엔 숨김).
  //
  // 안정화 배치(2026-09-22, nav 깜빡임) — 예전엔 "회원" 탭 하나만 쿠키로 캐싱해 그 탭만
  // 안 깜빡였고, 나머지 15개 이상 권한 게이트 메뉴(매출·결제/스태프·권한/룸 관리 등)는
  // fetchMyEffectivePermissionKeys()가 끝날 때까지 전부 숨겨졌다가 한꺼번에 나타났다
  // ("탭 4개→전체" 신고). initialNavState(오너 여부 + 보유 권한 키 전체, 서버 쿠키로
  // 캐싱됨 — app/manager/layout.tsx, lib/roles.ts 참고)를 초기값으로 써서 첫 페인트부터
  // 전체 메뉴가 정확하게 그려지게 한다. 이 캐시는 순수 UX 힌트라 실제 접근 통제(RLS)를
  // 느슨하게 만들지 않는다 — 아래에서 실시간 재확인 결과로 항상 덮어쓴다.
  const [isOwner, setIsOwner] = useState(initialNavState?.isOwner ?? false);
  const [myPerms, setMyPerms] = useState<Set<string> | null>(initialNavState?.permKeys ?? null);
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
  // 2026-10-02 성능: pathname이 바뀔 때마다 fetchMyCenters + 권한을 다시 받던 것을 "마지막 확인 후 60초가 지났을 때"로 줄인다(같은 세션에서 탭마다 같은 결과를
  // 다시 가져오던 비용 제거). 권한 변경 반영은 유지한다: 60초 초과 시 다음 이동에서, 앱/탭이 다시 보일 때(visibilitychange)도 재확인한다. 접근 통제(RLS)는 그대로다.
  const lastCheckRef = useRef(0);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  // 권한 재확인 단일 함수: TTL 안이거나 이미 조회 중이면 건너뛴다(동시 중복 fetch 방지). 이동(pathname)과 앱/탭 복귀(visible) 양쪽이 같은 함수를 쓴다.
  // 결과 반영은 "아직 마운트돼 있는지"로만 막는다(예전처럼 effect cleanup으로 취소하면 이동 중 진행 중이던 조회가 버려지고 TTL 때문에 재조회도 안 된다).
  const recheckPermissions = useCallback(() => {
    if (inFlightRef.current) return;
    if (lastCheckRef.current && Date.now() - lastCheckRef.current < NAV_PERM_RECHECK_MS) return;
    inFlightRef.current = true;
    lastCheckRef.current = Date.now();
    fetchMyCenters()
      .then((centers) => {
        if (!mountedRef.current || centers.length === 0) { if (mountedRef.current) setResolved(true); return; }
        const active = centers[0];
        setIsOwner(active.isOwner);
        if (active.isOwner) { setResolved(true); return; }
        return fetchMyEffectivePermissionKeys(active.managerCenterId, active.roleId).then((keys) => {
          if (mountedRef.current) { setMyPerms(keys); setResolved(true); }
        });
      })
      .catch(() => { lastCheckRef.current = 0; if (mountedRef.current) setResolved(true); })   // 실패하면 다음 기회에 바로 재시도
      .finally(() => { inFlightRef.current = false; });
  }, []);
  useEffect(() => { recheckPermissions(); }, [pathname, recheckPermissions]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") recheckPermissions(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [recheckPermissions]);

  const liveCanSeeMembers = canSeeManagerMenu(isOwner, myPerms, "customer.member.view");
  useEffect(() => {
    if (resolved) {
      setCachedCanSeeMembers(liveCanSeeMembers);
      // 오너면 개별 권한 목록이 없어도(myPerms=null) 전권이므로 빈 Set을 캐싱해도 무방 —
      // 다음 로드 때 initialNavState.isOwner만으로 canSeeManagerMenu가 true를 반환한다.
      setCachedManagerNavState(isOwner, myPerms ?? new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, liveCanSeeMembers, isOwner, myPerms]);
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
    // 이벤트 burst(키보드 애니메이션 중 resize/scroll 연속 발생)를 프레임당 한 번으로 합치고, 값이 같으면 setState하지 않는다.
    let raf = 0;
    const apply = () => { raf = 0; const open = window.innerHeight - viewport.height > 140; setKeyboardOpen((prev) => (prev === open ? prev : open)); };
    const check = () => { if (!raf) raf = requestAnimationFrame(apply); };
    viewport.addEventListener("resize", check);
    viewport.addEventListener("scroll", check);
    apply();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      viewport.removeEventListener("resize", check);
      viewport.removeEventListener("scroll", check);
    };
  }, []);

  // 안정화 배치(2026-09-22) — 항목 8/9/10: 768–1359 터치 확장 rail + scroll 위치 유지.
  const { navRef, scrollRef, expanded, handleRailClick, collapseAfterNavigate } =
    useExpandableNavRail("manager_nav_scroll_top");

  return (
    <>
      <NotificationToaster />
      <aside
        ref={navRef as React.RefObject<HTMLElement>}
        className="workspace-sidebar manager-sidebar"
        aria-label="센터 관리자 메뉴"
        aria-expanded={expanded}
        onClick={handleRailClick}
      >
        <Link className="desktop-brand" href="/manager" prefetch={false}>
          <span className="desktop-brand-mark">M</span>
          <span><b>모하빗</b><small>센터 관리자</small></span>
        </Link>
        <div className="workspace-sidebar-scroll" ref={scrollRef}>
          <div className="desktop-nav-section">업무</div>
          <a className={`desktop-nav-item ${pathname === "/manager" ? "active" : ""}`} href="/manager" onClick={(e) => replaceTabNavigation(e, "/manager")}><UiIcon name="grid" /><span>대시보드</span></a>
          <Link className={`desktop-nav-item ${is("/manager/classes") ? "active" : ""}`} href="/manager/classes" replace onClick={collapseAfterNavigate}><UiIcon name="calendar" /><span>수업·예약</span></Link>
          {canSeeMembers && <Link className={`desktop-nav-item ${is("/manager/members") ? "active" : ""}`} href="/manager/members" replace onClick={collapseAfterNavigate}><UiIcon name="users" /><span>회원</span></Link>}
          <Link className={`desktop-nav-item ${is("/manager/notifications") ? "active" : ""}`} href="/manager/notifications" replace onClick={collapseAfterNavigate}>
            <UiIcon name="bell" /><span>알림</span>{unread > 0 && <span className="desktop-nav-badge">{unread > 99 ? "99+" : unread}</span>}
          </Link>
          {canSee("pass.sales.view") && <Link className={`desktop-nav-item ${is("/manager/sales") ? "active" : ""}`} href="/manager/sales" prefetch={false}><UiIcon name="receipt" /><span>매출·결제</span></Link>}

          <div className="desktop-nav-section">고객 관리</div>
          {canSee("customer.lead.view") && <Link className={`desktop-nav-item ${is("/manager/leads") ? "active" : ""}`} href="/manager/leads" prefetch={false}><UiIcon name="message" /><span>상담고객</span></Link>}
          {canSee("customer.progress") && <Link className={`desktop-nav-item ${is("/manager/progress") ? "active" : ""}`} href="/manager/progress/record" prefetch={false}><UiIcon name="edit" /><span>진도 기록</span></Link>}
          {canSee("message.alimtalk.view") && <Link className={`desktop-nav-item ${is("/manager/alimtalk") ? "active" : ""}`} href="/manager/alimtalk" prefetch={false}><UiIcon name="megaphone" /><span>알림톡</span></Link>}
          {canSee("pass.order.view") && <Link className={`desktop-nav-item ${is("/manager/orders") ? "active" : ""}`} href="/manager/orders" prefetch={false}><UiIcon name="cart" /><span>주문</span></Link>}
          {canSee("customer.member.issue_pass") && <Link className={`desktop-nav-item ${is("/manager/coupons") ? "active" : ""}`} href="/manager/coupons" prefetch={false}><UiIcon name="card" /><span>쿠폰</span></Link>}
          {canSee("board.notice.view") && <Link className={`desktop-nav-item ${is("/manager/announcements") ? "active" : ""}`} href="/manager/announcements" prefetch={false}><UiIcon name="megaphone" /><span>공지사항</span></Link>}
          {canSee("board.inquiry.view") && <Link className={`desktop-nav-item ${is("/manager/inquiries") ? "active" : ""}`} href="/manager/inquiries" prefetch={false}><UiIcon name="message" /><span>1:1 문의</span></Link>}
          {canSee("facility.review.view") && <Link className={`desktop-nav-item ${is("/manager/reviews") ? "active" : ""}`} href="/manager/reviews" prefetch={false}><UiIcon name="star" /><span>후기</span></Link>}

          <div className="desktop-nav-section">센터 설정</div>
          {(canSee("pass.create") || canSee("pass.update")) && <Link className={`desktop-nav-item ${is("/manager/membership-rules") ? "active" : ""}`} href="/manager/membership-rules" prefetch={false}><UiIcon name="ticket" /><span>수강권</span></Link>}
          {canSee("pass.goods.view") && <Link className={`desktop-nav-item ${is("/manager/goods") ? "active" : ""}`} href="/manager/goods" prefetch={false}><UiIcon name="receipt" /><span>상품</span></Link>}
          {canSee("facility.staff.view") && <Link className={`desktop-nav-item ${is("/manager/staff") ? "active" : ""}`} href="/manager/staff" prefetch={false}><UiIcon name="shield" /><span>스태프·권한</span></Link>}
          {canSee("facility.info") && <Link className={`desktop-nav-item ${is("/manager/center-info") ? "active" : ""}`} href="/manager/center-info" prefetch={false}><UiIcon name="building" /><span>센터 정보</span></Link>}
          {canSee("facility.room") && <Link className={`desktop-nav-item ${is("/manager/rooms") ? "active" : ""}`} href="/manager/rooms" prefetch={false}><UiIcon name="building" /><span>룸 관리</span></Link>}
          {canSee("facility.operation") && <Link className={`desktop-nav-item ${is("/manager/settings") ? "active" : ""}`} href="/manager/settings" prefetch={false}><UiIcon name="settings" /><span>운영 설정</span></Link>}
          {isOwner && <Link className={`desktop-nav-item ${is("/manager/subscription") ? "active" : ""}`} href="/manager/subscription" prefetch={false}><UiIcon name="card" /><span>플랫폼 구독</span></Link>}
          {isOwner && <Link className={`desktop-nav-item ${is("/manager/settlement") ? "active" : ""}`} href="/manager/settlement" prefetch={false}><UiIcon name="bank" /><span>정산계좌</span></Link>}
        </div>
        <a className="workspace-sidebar-mode" href="/" onClick={(e) => replaceTabNavigation(e, "/")}><UiIcon name="user" /><span>회원 화면으로 전환</span></a>
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
