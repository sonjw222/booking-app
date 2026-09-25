"use client";

/*
  하단 네비게이션 (모든 회원 화면 공통)
  - 회원 상태와 관계없이 홈 / 찾기 / 예약 / 마이 4개를 고정한다.
  - 알림은 홈 헤더와 마이페이지에서 접근한다.
*/

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import NotificationToaster from "./NotificationToaster";
import UiIcon from "./UiIcon";

export default function BottomNav() {
  const pathname = usePathname();
  const is = (p: string) => (p === "/" ? pathname === "/" : pathname.startsWith(p));
  const isMyReservations = is("/my-reservations") || pathname.startsWith("/mypage/calendar");
  const isMypage = (is("/mypage") && !pathname.startsWith("/mypage/calendar")) ||
    ["/notifications", "/profiles", "/purchases", "/inquiries", "/settings", "/cart", "/checkout"].some(is);
  const isDiscovery = is("/search") || is("/category") || is("/center");
  const isReservation = is("/reservation") || isMyReservations;

  const [keyboardOpen, setKeyboardOpen] = useState(false);

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
        <Link className={`desktop-nav-item ${is("/") ? "active" : ""}`} href="/" replace aria-current={is("/") ? "page" : undefined}>
          <UiIcon name="home" /><span>홈</span>
        </Link>
        <Link className={`desktop-nav-item ${isDiscovery ? "active" : ""}`} href="/search" replace aria-current={isDiscovery ? "page" : undefined}>
          <UiIcon name="search" /><span>찾기</span>
        </Link>
        <Link className={`desktop-nav-item ${isReservation ? "active" : ""}`} href="/reservation" replace aria-current={isReservation ? "page" : undefined}>
          <UiIcon name="calendar" /><span>예약</span>
        </Link>
        <Link className={`desktop-nav-item ${isMypage ? "active" : ""}`} href="/mypage" replace aria-current={isMypage ? "page" : undefined}>
          <UiIcon name="user" /><span>마이</span>
        </Link>
        <div className="desktop-nav-spacer" />
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
        <Link className={`nav-item ${is("/") ? "active" : ""}`} href="/" replace aria-current={is("/") ? "page" : undefined}>
          <div className="nav-icon"><UiIcon name="home" /></div>홈
        </Link>
        <Link className={`nav-item ${isDiscovery ? "active" : ""}`} href="/search" replace aria-current={isDiscovery ? "page" : undefined}>
          <div className="nav-icon"><UiIcon name="search" /></div>찾기
        </Link>
        <Link className={`nav-item ${isReservation ? "active" : ""}`} href="/reservation" replace aria-current={isReservation ? "page" : undefined}>
          <div className="nav-icon"><UiIcon name="calendar" /></div>예약
        </Link>
        <Link className={`nav-item ${isMypage ? "active" : ""}`} href="/mypage" replace aria-current={isMypage ? "page" : undefined}>
          <div className="nav-icon"><UiIcon name="user" /></div>마이
        </Link>
      </nav>
    </>
  );
}
