"use client";

/*
  알림 설정
  - 예약 확정/취소, 대기 승격, 수업 리마인더, 마케팅 알림 등 on/off
  - 설정은 이 기기에 저장 (실제 푸시/알림톡 발송 연동은 추후)
*/

import { useCallback, useEffect, useState } from "react";
import BottomNav from "../../components/BottomNav";

type NotiKey = "reservation" | "waitlist" | "reminder" | "marketing";

const ITEMS: { key: NotiKey; label: string; desc: string }[] = [
  { key: "reservation", label: "예약 확정·취소 알림", desc: "예약이 확정되거나 취소될 때" },
  { key: "waitlist", label: "대기 승격 알림", desc: "대기하던 수업에 자리가 났을 때" },
  { key: "reminder", label: "수업 리마인더", desc: "수업 시작 전 미리 알려드려요" },
  { key: "marketing", label: "혜택·이벤트 알림", desc: "쿠폰, 이벤트 등 마케팅 소식" },
];

const DEFAULTS: Record<NotiKey, boolean> = {
  reservation: true, waitlist: true, reminder: true, marketing: false,
};

export default function NotificationSettingsPage() {
  const [prefs, setPrefs] = useState<Record<NotiKey, boolean>>(DEFAULTS);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("noti_prefs");
      if (saved) setPrefs({ ...DEFAULTS, ...JSON.parse(saved) });
    } catch { /* 무시 */ }
  }, []);

  const toggle = useCallback((key: NotiKey) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem("noti_prefs", JSON.stringify(next)); } catch { /* 무시 */ }
      return next;
    });
    setToast("설정을 저장했어요");
    setTimeout(() => setToast(null), 1500);
  }, []);

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">알림 설정</div>
        <div className="side" />
      </div>

      <div className="perm-guide" style={{ margin: "8px 20px" }}>
        받고 싶은 알림을 골라주세요. 앱 내 알림은 즉시 제공되며, 문자·카카오 알림톡·푸시·이메일
        발송 연동은 아직 준비 중이에요.
      </div>

      <div className="noti-list">
        {ITEMS.map((it) => (
          <div key={it.key} className="noti-row">
            <div className="noti-info">
              <div className="noti-label">{it.label}</div>
              <div className="noti-desc">{it.desc}</div>
            </div>
            <button className={`switch ${prefs[it.key] ? "on" : ""}`} onClick={() => toggle(it.key)}>
              <span className="knob" />
            </button>
          </div>
        ))}
      </div>
      <BottomNav />
    </div>
  );
}
