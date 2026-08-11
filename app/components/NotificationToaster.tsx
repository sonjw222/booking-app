"use client";

/*
  실시간 알림 팝업
  - 로그인 상태에서 새 알림이 오면 화면 상단에 토스트 팝업
  - 여러 개 쌓이면 순서대로 표시, 몇 초 후 자동 사라짐
  - 탭하면 해당 링크로 이동
  - BottomNav / ManagerNav 에 포함되어 대부분 화면에서 동작
*/

import { useEffect, useState } from "react";
import {
  subscribeNotifications, notiEmoji, notificationHref, getNotiPrefs, notiPrefKeyForKind,
  type Notification,
} from "../../lib/notifications";

export default function NotificationToaster() {
  const [popups, setPopups] = useState<Notification[]>([]);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let mounted = true;

    subscribeNotifications((n) => {
      if (!mounted) return;
      // 알림 설정(app/settings/notifications)에서 이 종류를 껐으면 팝업만 건너뛴다 —
      // 알림 자체는 서버에 이미 기록됐으니 알림함(/notifications)에서는 그대로 보인다.
      const prefKey = notiPrefKeyForKind(n.kind);
      if (prefKey && !getNotiPrefs()[prefKey]) return;
      setPopups((prev) => [n, ...prev].slice(0, 3));
      // 5초 후 자동 제거
      setTimeout(() => {
        setPopups((prev) => prev.filter((p) => p.id !== n.id));
      }, 5000);
    }).then((fn) => { unsub = fn; });

    return () => { mounted = false; if (unsub) unsub(); };
  }, []);

  if (popups.length === 0) return null;

  return (
    <div className="noti-toaster">
      {popups.map((n) => (
        <a
          key={n.id}
          className="noti-popup"
          href={notificationHref(n)}
          onClick={() => setPopups((prev) => prev.filter((p) => p.id !== n.id))}
        >
          <span className="noti-popup-emoji">{notiEmoji(n.kind)}</span>
          <span className="noti-popup-text">
            <span className="noti-popup-title">{n.title}</span>
            <span className="noti-popup-body">{n.body}</span>
          </span>
        </a>
      ))}
    </div>
  );
}
