"use client";

/*
  알림 설정
  - 예약 확정/취소, 대기 승격, 수업 리마인더 등의 "실시간 팝업 알림" on/off
  - 설정은 이 기기(브라우저)에 저장되고, NotificationToaster가 이 값을 읽어 팝업 표시
    여부를 실제로 걸러낸다(lib/notifications.ts의 notiPrefKeyForKind) — 꺼도 알림함
    (/notifications)에는 그대로 기록되니 나중에 확인할 수 있다. 서버가 알림을 만드는
    것 자체를 막는 건 아니다(예약/취소 트리거는 항상 발생 — 감사 로그 성격).
  - 혜택·이벤트(마케팅) 알림은 아직 그 알림을 만드는 기능 자체가 없어 토글이 준비 중이다.
  - 문자·카카오 알림톡·푸시·이메일 발송 연동은 별도(추후, 외부 계약 필요).
*/

import { useCallback, useEffect, useState } from "react";
import BottomNav from "../../components/BottomNav";
import { NOTI_PREF_STORAGE_KEY, NOTI_PREF_DEFAULTS, getNotiPrefs, type NotiPrefKey } from "../../../lib/notifications";

const ITEMS: { key: NotiPrefKey; label: string; desc: string; ready: boolean }[] = [
  { key: "reservation", label: "예약 확정·취소 알림", desc: "예약이 확정되거나 취소될 때 팝업으로 알려드려요", ready: true },
  { key: "waitlist", label: "대기 승격 알림", desc: "대기하던 수업에 자리가 났을 때 팝업으로 알려드려요", ready: true },
  { key: "reminder", label: "수업 리마인더", desc: "수업 시작 전 미리 팝업으로 알려드려요", ready: true },
  { key: "marketing", label: "혜택·이벤트 알림", desc: "쿠폰, 이벤트 등 마케팅 소식 (준비 중)", ready: false },
];

export default function NotificationSettingsPage() {
  const [prefs, setPrefs] = useState<Record<NotiPrefKey, boolean>>(NOTI_PREF_DEFAULTS);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setPrefs(getNotiPrefs());
  }, []);

  const toggle = useCallback((key: NotiPrefKey) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(NOTI_PREF_STORAGE_KEY, JSON.stringify(next)); } catch { /* 무시 */ }
      return next;
    });
    setToast("설정을 저장했어요");
    setTimeout(() => setToast(null), 1500);
  }, []);

  return (
    <div className="app-shell account-page-v2 settings-page-v2">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">알림 설정</div>
        <div className="side" />
      </div>

      <div className="perm-guide" style={{ margin: "8px 20px" }}>
        꺼두면 이 종류는 실시간 팝업으로 방해하지 않아요(알림함에는 그대로 남아 나중에 확인할
        수 있어요). 문자·카카오 알림톡·푸시·이메일 발송 연동은 아직 준비 중이에요.
      </div>

      <div className="noti-list">
        {ITEMS.map((it) => (
          <div key={it.key} className="noti-row">
            <div className="noti-info">
              <div className="noti-label">{it.label}</div>
              <div className="noti-desc">{it.desc}</div>
            </div>
            <button
              className={`switch ${prefs[it.key] && it.ready ? "on" : ""}`}
              onClick={() => it.ready && toggle(it.key)}
              disabled={!it.ready}
            >
              <span className="knob" />
            </button>
          </div>
        ))}
      </div>
      <BottomNav />
    </div>
  );
}
