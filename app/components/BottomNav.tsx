"use client";

/*
  하단 네비게이션 (모든 회원 화면 공통)
  - 홈 / 예약 / 내 예약 / 알림 / 마이페이지
  - 알림 탭에 안읽음 뱃지 + 실시간 팝업
*/

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchUnreadCount, subscribeNotifications } from "../../lib/notifications";
import {
  fetchHasUsableMembership, shouldShowMembershipTabs,
  setCachedHasUsableMembership,
} from "../../lib/navState";
import NotificationToaster from "./NotificationToaster";
import UiIcon from "./UiIcon";

export default function BottomNav({ initialHasUsable = null }: { initialHasUsable?: boolean | null }) {
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
  // 릴리스 폴리시 배치(2026-09-14) — 이 앱은 클라이언트 라우팅이 없어 탭 전환마다 전체
  // 페이지가 서버에서부터 다시 그려진다. localStorage 기반 useLayoutEffect 보정은 서버
  // 렌더링(=최초 페인트) 자체에는 영향을 못 줘서 "3탭 화면이 먼저 그려졌다가 5탭으로
  // 바뀌는" 깜빡임을 못 막았다 — 대신 app/layout.tsx(서버 컴포넌트)가 쿠키(lib/navState.ts의
  // parseHasUsableMembershipCookie)를 읽어 이 값을 서버 렌더링 시점부터 이미 맞는 상태로
  // 내려준다. initialHasUsable이 null이면(쿠키 없음, 최초 진입) 기존과 동일하게 판정 전까지
  // 3탭으로 안전하게 시작한다.
  const [hasUsable, setHasUsable] = useState<boolean | null>(initialHasUsable);
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
      <aside className="member-desktop-nav" aria-label="회원 데스크톱 메뉴">
        <Link className="desktop-brand" href="/" replace aria-label="모하빗 홈">
          <span className="desktop-brand-mark">M</span>
          <span><b>모하빗</b><small>나에게 맞는 움직임</small></span>
        </Link>
        <div className="desktop-nav-section">둘러보기</div>
        <Link className={`desktop-nav-item ${is("/") ? "active" : ""}`} href="/" replace>
          <UiIcon name="home" /><span>홈</span>
        </Link>
        {showMembershipTabs && (
          <Link className={`desktop-nav-item ${is("/reservation") ? "active" : ""}`} href="/reservation" replace>
            <UiIcon name="calendar" /><span>예약</span>
          </Link>
        )}
        {showMembershipTabs && (
          <Link className={`desktop-nav-item ${isMyReservations ? "active" : ""}`} href="/my-reservations" replace>
            <UiIcon name="list" /><span>내 예약</span>
          </Link>
        )}
        <div className="desktop-nav-section">내 활동</div>
        <Link className={`desktop-nav-item ${is("/notifications") ? "active" : ""}`} href="/notifications" replace>
          <UiIcon name="bell" /><span>알림</span>
          {unread > 0 && <span className="desktop-nav-badge">{unread > 99 ? "99+" : unread}</span>}
        </Link>
        <Link className={`desktop-nav-item ${isMypage ? "active" : ""}`} href="/mypage" replace>
          <UiIcon name="user" /><span>마이페이지</span>
        </Link>
        <Link className={`desktop-nav-item ${is("/search") ? "active" : ""}`} href="/search" replace>
          <UiIcon name="search" /><span>센터 찾기</span>
        </Link>
        <div className="desktop-nav-spacer" />
        <div className="desktop-nav-note">태블릿과 데스크톱에서는 더 넓은 화면으로 편하게 탐색할 수 있어요.</div>
      </aside>
      {/* 릴리스 폴리시 배치(2026-09-14, 3차) — 실기기에서 탭 전환이 느리고 스켈레톤이
          반복되고 화면이 깜빡인다는 신고의 근본 원인은 이 nav가 <a href>라 클릭마다 전체
          문서를 서버에서 다시 받아왔기 때문이다(app/layout.tsx 주석에 있던 "이 앱은
          클라이언트 라우팅 없음" 설명 자체가 이 nav 한정으로는 낡은 전제였음 — 정작
          app/reservation/page.tsx, app/components/BackButton.tsx 등 다른 화면에서는 이미
          이전부터 Next.js router.push()/router.back()으로 실제 클라이언트 전환이 문제
          없이 쓰이고 있었다는 게 이번에 확인됨). 이 nav가 감싸는 5개 탭은 전부 같은 루트
          레이아웃(app/layout.tsx) 아래에 있어 레이아웃 자체는 유지한 채 탭 콘텐츠만
          바뀌는 게 안전하다 — <Link>로 바꾸면 CapacitorBootstrap/SessionWatcher/테마
          스크립트가 탭마다 다시 실행되던 낭비도 같이 없어진다(전부 세션당 한 번만 필요한
          초기화). 이 nav 밖의(각 화면 안쪽) 다른 <a href> 링크들은 이번 범위 밖 —
          docs/TODO.md P3-12 참고, 전면 전환은 별도 배치. */}
      {/* 릴리스 폴리시 배치 6차(2026-09-15) — 탭 전환은 edge-swipe 뒤로가기로 이전 탭에
          "되돌아가면" 안 된다(예: 마이 → 예약 tab → edge swipe → 마이로 복귀 = FAIL).
          Next.js <Link>의 replace prop은 router.replace()를 써서 history.replaceState로
          이동한다(pushState와 달리 WKWebView 뒤로가기 목록에 새 항목을 안 남김) — 탭
          5개 전부 동일하게 적용. */}
      <nav className={`bottom-nav ${keyboardOpen ? "keyboard-hidden" : ""}`} aria-label="회원 주요 메뉴">
        <Link className={`nav-item ${is("/") ? "active" : ""}`} href="/" replace>
          <div className="nav-icon"><UiIcon name="home" /></div>홈
        </Link>
        {showMembershipTabs && (
          <Link className={`nav-item ${is("/reservation") ? "active" : ""}`} href="/reservation" replace>
            <div className="nav-icon"><UiIcon name="calendar" /></div>예약
          </Link>
        )}
        {showMembershipTabs && (
          <Link className={`nav-item ${isMyReservations ? "active" : ""}`} href="/my-reservations" replace>
            <div className="nav-icon"><UiIcon name="list" /></div>내 예약
          </Link>
        )}
        <Link className={`nav-item ${is("/notifications") ? "active" : ""}`} href="/notifications" replace>
          <div className="nav-icon" style={{ position: "relative" }}>
            <UiIcon name="bell" />
            {unread > 0 && <span className="nav-badge">{unread > 9 ? "9+" : unread}</span>}
          </div>알림
        </Link>
        <Link className={`nav-item ${isMypage ? "active" : ""}`} href="/mypage" replace>
          <div className="nav-icon"><UiIcon name="user" /></div>마이
        </Link>
      </nav>
    </>
  );
}
