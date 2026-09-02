"use client";

/*
  매니저 - 알림톡 관리 (더보기 > 알림톡)
  - 알림톡 보내기 / 자동 발송 규칙 / 템플릿 관리 / 발신 설정 4개 메뉴
  - message.alimtalk.view 권한 필요(app/manager/page.tsx와 동일한 게이팅)
*/

import UiIcon from "../../components/UiIcon";

export default function AlimtalkHomePage() {
  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">알림톡</div>
        <div className="side" />
      </div>

      <div className="menu-section-label">발송</div>
      <a className="list-row" href="/manager/alimtalk/send">
        <div className="left"><span className="icon"><UiIcon name="message" /></span>알림톡 보내기</div>
        <span className="chevron">›</span>
      </a>

      <div className="menu-section-label">자동화</div>
      <a className="list-row" href="/manager/alimtalk/rules">
        <div className="left"><span className="icon"><UiIcon name="bell" /></span>자동 발송 규칙</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/manager/alimtalk/templates">
        <div className="left"><span className="icon"><UiIcon name="edit" /></span>템플릿 관리</div>
        <span className="chevron">›</span>
      </a>

      <div className="menu-section-label">연동</div>
      <a className="list-row" href="/manager/alimtalk/settings">
        <div className="left"><span className="icon"><UiIcon name="settings" /></span>발신 설정</div>
        <span className="chevron">›</span>
      </a>
    </div>
  );
}
