"use client";

/*
  운영자 설정 허브
  - 센터 승인 관리 / 종목 관리 / 배너 관리 로 진입
*/

import { useEffect, useState } from "react";
import { checkPlatformAdmin } from "../../lib/admin";
import Loading from "../components/Loading";
import UiIcon from "../components/UiIcon";

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
          <a className="side" href="/mypage">‹</a>
          <div className="title">운영자 설정</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 60 }}>운영자만 접근할 수 있어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">운영자 설정</div>
        <div className="side" />
      </div>

      <div className="menu-section-label">관리</div>
      <a className="list-row" href="/admin/centers">
        <div className="left"><span className="icon"><UiIcon name="building" /></span>센터 승인 관리</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/admin/categories">
        <div className="left"><span className="icon"><UiIcon name="grid" /></span>종목 관리</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/admin/banners">
        <div className="left"><span className="icon"><UiIcon name="megaphone" /></span>배너 관리</div>
        <span className="chevron">›</span>
      </a>
    </div>
  );
}
