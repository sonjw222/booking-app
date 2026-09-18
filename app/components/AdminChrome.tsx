"use client";

import { usePathname, useRouter } from "next/navigation";
import UiIcon from "./UiIcon";
import { replaceTabNavigation } from "../../lib/navState";

const TITLES: Record<string, string> = {
  "/admin": "운영 홈", "/admin/centers": "센터 승인", "/admin/categories": "종목 관리", "/admin/banners": "홈 배너",
  "/admin/settlement": "센터 정산", "/admin/subscriptions": "구독 현황", "/admin/subscription-plans": "구독 플랜",
  "/admin/marketing": "마케팅 알림", "/admin/reviews": "후기 신고 관리",
};

export default function AdminChrome() {
  const pathname = usePathname();
  const router = useRouter();
  return <header className="admin-chrome">
    <div className="app-chrome-title">
      {pathname !== "/admin" && <button type="button" className="app-back-btn" onClick={() => router.back()} aria-label="뒤로가기">‹</button>}
      <h1>{TITLES[pathname] ?? "플랫폼 운영"}</h1>
    </div>
    {/* 릴리스 폴리시 배치 8차(2026-09-17) — 기존엔 이 버튼이 "/admin"(운영 홈)로 이동하는
        중복 진입점이었다(운영 홈 자체는 이미 뒤로가기로 도달 가능, AdminNav 사이드바에도
        있음). 실기기 UX 피드백: 방패 아이콘이 "운영자 모드로"처럼 보여 반대 의미(운영자
        모드를 "나가는" 버튼)로 오해하기 쉬웠다 — 기능 자체를 "운영자 모드 종료 → 회원
        모드 마이 root로 이동"으로 바꾸고, 아이콘도 의미가 분명한 사람+화살표로 교체.
        replaceTabNavigation으로 이동해 이후 뒤로가기로 운영 홈에 복귀하지 않는다
        (navigation policy 4-6). */}
    <a href="/mypage" aria-label="회원 모드로 돌아가기" onClick={(e) => replaceTabNavigation(e, "/mypage")}>
      <UiIcon name="userReturn" size={22} /><span>회원 모드로</span>
    </a>
  </header>;
}
