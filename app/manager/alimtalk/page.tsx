"use client";

/*
  매니저 - 알림톡 관리 (더보기 > 알림톡)
  - 알림톡 보내기 / 자동 발송 규칙 / 템플릿 관리 / 발신 설정 4개 메뉴
  - message.alimtalk.view 권한 필요(app/manager/page.tsx와 동일한 게이팅)
*/

import Link from "next/link";
import UiIcon from "../../components/UiIcon";

export default function AlimtalkHomePage() {
  return (
    <div className="app-shell">
      <div className="back-header">
        <Link className="side" href="/manager" prefetch={false}>‹</Link>
        <div className="title">알림톡</div>
        <div className="side" />
      </div>

      <div className="menu-section-label">발송</div>
      <Link className="list-row" href="/manager/alimtalk/send" prefetch={false}>
        <div className="left"><span className="icon"><UiIcon name="message" /></span>알림톡 보내기</div>
        <span className="chevron">›</span>
      </Link>

      <div className="menu-section-label">자동화</div>
      <Link className="list-row" href="/manager/alimtalk/rules" prefetch={false}>
        <div className="left"><span className="icon"><UiIcon name="bell" /></span>자동 발송 규칙</div>
        <span className="chevron">›</span>
      </Link>
      <Link className="list-row" href="/manager/alimtalk/templates" prefetch={false}>
        <div className="left"><span className="icon"><UiIcon name="edit" /></span>템플릿 관리</div>
        <span className="chevron">›</span>
      </Link>

      <div className="menu-section-label">연동</div>
      <Link className="list-row" href="/manager/alimtalk/settings" prefetch={false}>
        <div className="left"><span className="icon"><UiIcon name="settings" /></span>발신 설정</div>
        <span className="chevron">›</span>
      </Link>
    </div>
  );
}
