"use client";

/*
  매니저 - 알림톡 관리 (더보기 > 알림톡)
  - 알림톡 보내기 / 자동 발송 규칙 / 템플릿 관리 / 발신 설정 4개 메뉴
  - message.alimtalk.view 권한 필요(app/manager/page.tsx와 동일한 게이팅)
*/

import Link from "next/link";
import { useEffect, useState } from "react";
import UiIcon from "../../components/UiIcon";
import PermissionGateShell from "../../components/PermissionGateShell";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { useAnyCenterPermissionGate } from "../../../lib/permissionGate";

export default function AlimtalkHomePage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => { fetchMyCenters().then(setCenters).catch(() => setLoadError("센터 정보를 불러오지 못했어요")).finally(() => setLoaded(true)); }, []);
  // 메뉴(app/manager/page.tsx)와 같은 권한(message.alimtalk.view) — 소속 센터 중 하나라도 있으면 열린다. 확인 중·실패는 허용이 아니다.
  const gateRaw = useAnyCenterPermissionGate(centers, loaded, "message.alimtalk.view");
  const gate = loadError ? "error" : gateRaw;
  if (gate !== "allowed") return <PermissionGateShell title="알림톡" backHref="/manager" state={gate} what="알림톡" />;
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
