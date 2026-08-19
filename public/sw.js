// 웹 푸시 서비스 워커 (P1-3 일부).
// 앱 탭이 닫혀 있거나 백그라운드일 때도 push 이벤트를 받아 OS 알림을 띄우기 위해
// 필요하다 — Web Push API의 요구사항(서비스 워커 없이는 push 이벤트를 받을 수 없음).
self.addEventListener("push", (event) => {
  let data = { title: "알림", body: "", link: "/notifications" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // 무시 — 기본값 사용
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { link: data.link },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification.data?.link || "/notifications";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(link);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(link);
    })
  );
});
