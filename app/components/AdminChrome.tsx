"use client";

import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import UiIcon from "./UiIcon";

const TITLES: Record<string, string> = {
  "/admin": "운영 홈", "/admin/centers": "센터 승인", "/admin/categories": "종목 관리", "/admin/banners": "홈 배너",
};

export default function AdminChrome() {
  const pathname = usePathname();
  const router = useRouter();
  const showBack = pathname !== "/admin";
  return (
    <header className="admin-chrome">
      <div className="app-chrome-title">
        {showBack && <button className="app-back-btn" onClick={() => router.back()} aria-label="뒤로가기">‹</button>}
        <div><span>플랫폼 관리</span><h1>{TITLES[pathname] ?? "플랫폼 운영"}</h1></div>
      </div>
      <a href="/admin" aria-label="운영 홈"><UiIcon name="shield" size={23} /><span>운영 홈</span></a>
    </header>
  );
}
