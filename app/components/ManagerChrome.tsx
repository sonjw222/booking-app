"use client";

import { usePathname, useRouter } from "next/navigation";
import UiIcon from "./UiIcon";

const TITLES: Record<string, string> = {
  "/manager": "관리 홈", "/manager/classes": "수업", "/manager/members": "회원",
  "/manager/notifications": "알림", "/manager/membership-rules": "수강권",
  "/manager/goods": "상품", "/manager/progress": "진도", "/manager/progress/record": "진도 기록",
  "/manager/staff": "스태프", "/manager/staff/permissions": "권한",
  "/manager/sales": "매출·결제", "/manager/announcements": "공지",
  "/manager/inquiries": "문의", "/manager/reviews": "후기", "/manager/orders": "주문",
  "/manager/admin-assignments": "회원 직접 배치 기록", "/manager/center-info": "센터 정보",
  "/manager/rooms": "룸 관리", "/manager/holidays": "휴무일", "/manager/settings": "예약 운영 설정",
  "/manager/class-revenue": "수업매출", "/manager/leads": "상담고객 관리",
};

export default function ManagerChrome() {
  const pathname = usePathname();
  const router = useRouter();
  const rootScreens = new Set(["/manager", "/manager/classes", "/manager/members", "/manager/notifications"]);
  return <header className="manager-chrome">
    <div className="manager-chrome-main">
      <div className="app-chrome-title">
        {!rootScreens.has(pathname) && <button type="button" className="app-back-btn" onClick={() => pathname === "/manager/settings" ? router.push("/manager") : router.back()} aria-label="뒤로가기">‹</button>}
        <h1>{TITLES[pathname] ?? "관리자"}</h1>
      </div>
      {pathname === "/manager" ? <a className="manager-member-link" href="/" aria-label="회원 화면"><UiIcon name="user" size={20} /><span>회원 화면</span></a>
        : <a className="manager-home-link" href="/manager" aria-label="관리 홈"><UiIcon name="grid" size={20} /><span>관리 홈</span></a>}
    </div>
  </header>;
}
