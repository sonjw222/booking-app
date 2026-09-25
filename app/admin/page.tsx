"use client";

/*
  운영자 설정 허브
  - 센터 승인 관리 / 종목 관리 / 배너 관리 로 진입
*/

import { useEffect, useState } from "react";
import { checkPlatformAdmin } from "../../lib/admin";
import Loading from "../components/Loading";
import UiIcon from "../components/UiIcon";
import EmptyState from "../components/EmptyState";
import BackButton from "../components/BackButton";

const GROUPS = [
  { title: "센터 운영", items: [
    { href: "/admin/centers", label: "센터 승인", detail: "등록 요청과 운영 상태", icon: "building" },
    { href: "/admin/categories", label: "종목 관리", detail: "서비스에 표시할 종목", icon: "grid" },
    { href: "/admin/reviews", label: "후기 신고", detail: "신고된 후기 확인", icon: "alert" },
  ] },
  { title: "요금과 정산", items: [
    { href: "/admin/subscriptions", label: "구독 현황", detail: "센터별 구독 상태", icon: "card" },
    { href: "/admin/subscription-plans", label: "구독 플랜", detail: "플랜 구성과 가격", icon: "ticket" },
    { href: "/admin/settlement", label: "센터 정산", detail: "정산 내역 확인", icon: "bank" },
  ] },
  { title: "콘텐츠와 소통", items: [
    { href: "/admin/banners", label: "홈 배너", detail: "홈 화면 노출 관리", icon: "megaphone" },
    { href: "/admin/marketing", label: "마케팅 알림", detail: "발송 내용 관리", icon: "message" },
  ] },
] as const;

export default function AdminHub() {
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    checkPlatformAdmin().then(setOk).catch(() => setOk(false));
  }, []);

  if (ok === null) return <div className="app-shell"><Loading /></div>;
  if (!ok) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <BackButton fallbackHref="/mypage" />
          <div className="title">운영자 설정</div>
          <div className="side" />
        </div>
        <EmptyState icon="shield" title="운영자만 접근할 수 있어요" description="권한이 있는 계정으로 로그인해 주세요."
          action={<a className="primary-btn" href="/mypage">마이페이지로</a>} />
      </div>
    );
  }

  return (
    <div className="app-shell admin-home-v2">
      <div className="back-header">
        <BackButton fallbackHref="/mypage" />
        <div className="title">운영자 설정</div>
        <div className="side" />
      </div>

      <div className="admin-home-intro"><h2>플랫폼 운영</h2><p>오늘 확인할 업무를 선택해 주세요.</p></div>
      {GROUPS.map((group) => <section key={group.title} className="admin-home-group" aria-label={group.title}>
        <h3>{group.title}</h3>
        <div className="admin-home-grid">
          {group.items.map((item) => <a className="admin-home-card" href={item.href} key={item.href}>
            <span className="admin-home-card-icon"><UiIcon name={item.icon} /></span>
            <span className="admin-home-card-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
            <span className="chevron" aria-hidden="true">›</span>
          </a>)}
        </div>
      </section>)}
    </div>
  );
}
