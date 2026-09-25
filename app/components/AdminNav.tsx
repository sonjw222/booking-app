"use client";

import { usePathname } from "next/navigation";
import UiIcon, { type IconName } from "./UiIcon";
import { replaceTabNavigation } from "../../lib/navState";
import { useExpandableNavRail } from "./useExpandableNavRail";

const ITEMS: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/admin", label: "운영 대시보드", icon: "grid" },
  { href: "/admin/centers", label: "센터 승인", icon: "building" },
  { href: "/admin/subscriptions", label: "구독 현황", icon: "card" },
  { href: "/admin/settlement", label: "센터 정산", icon: "bank" },
  { href: "/admin/categories", label: "종목 관리", icon: "sliders" },
  { href: "/admin/banners", label: "홈 배너", icon: "megaphone" },
  { href: "/admin/marketing", label: "마케팅 알림", icon: "message" },
  { href: "/admin/reviews", label: "후기 신고", icon: "alert" },
  { href: "/admin/subscription-plans", label: "구독 플랜", icon: "ticket" },
];

export default function AdminNav() {
  const pathname = usePathname();
  const active = (href: string) => href === "/admin" ? pathname === href : pathname.startsWith(href);
  // 안정화 배치(2026-09-22) — ManagerNav.tsx와 동일한 768–1359 터치 확장 rail +
  // scroll 위치 유지(useExpandableNavRail.ts 참고). 이 nav는 항목이 9개뿐이라
  // scroll 유지는 실사용 빈도가 낮지만, 두 nav가 동일 컴포넌트 구조(.workspace-sidebar)
  // 를 공유하므로 같은 훅으로 일관되게 처리한다.
  const { navRef, scrollRef, expanded, handleRailClick, collapseAfterNavigate } =
    useExpandableNavRail("admin_nav_scroll_top");
  return (
    <aside
      ref={navRef as React.RefObject<HTMLElement>}
      className="workspace-sidebar admin-sidebar"
      aria-label="플랫폼 운영 메뉴"
      aria-expanded={expanded}
      onClick={handleRailClick}
    >
      <a className="desktop-brand" href="/admin">
        <span className="desktop-brand-mark"><UiIcon name="shield" size={20} /></span>
        <span><b>모하빗</b><small>플랫폼 운영</small></span>
      </a>
      <div className="workspace-sidebar-scroll" ref={scrollRef}>
        <div className="desktop-nav-section">운영 관리</div>
        {ITEMS.map((item) => (
          <a key={item.href} className={`desktop-nav-item ${active(item.href) ? "active" : ""}`} href={item.href}
            aria-current={active(item.href) ? "page" : undefined}
            onClick={item.href === "/admin" ? (e) => replaceTabNavigation(e, "/admin") : () => collapseAfterNavigate()}>
            <UiIcon name={item.icon} /><span>{item.label}</span>
          </a>
        ))}
      </div>
      <a className="workspace-sidebar-mode" href="/" onClick={(e) => replaceTabNavigation(e, "/")}><UiIcon name="user" /><span>회원 화면으로 전환</span></a>
    </aside>
  );
}
