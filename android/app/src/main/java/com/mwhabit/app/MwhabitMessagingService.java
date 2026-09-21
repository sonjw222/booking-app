package com.mwhabit.app;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.BitmapFactory;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

// 알림 아이콘 실기기 QA(2026-09-21) — 풀컬러 앱 아이콘을 알림 왼쪽에 원형 아바타(large
// icon)로 보여달라는 요청. Capacitor push-notifications 플러그인은 앱당 하나뿐인
// FirebaseMessagingService(MessagingService.java)를 이미 등록해서 쓰고 있어 별도
// 서비스를 추가로 등록할 수 없다(둘 다 같은 "com.google.firebase.MESSAGING_EVENT"
// intent-filter를 노리면 어느 쪽이 실제로 호출될지 보장이 안 됨) — 그래서 Capacitor의
// MessagingService를 상속해 onMessageReceived만 확장하고, AndroidManifest.xml에서
// Capacitor 기본 서비스 등록을 tools:node="remove"로 지우고 이 클래스를 대신 등록한다.
//
// large icon은 Firebase의 자동 표시 경로(CommonNotificationBuilder)로는 넣을 방법이
// 없다 — 그 경로가 지원하는 건 payload의 "image" URL(BigPictureStyle, 알림 오른쪽
// 사각 썸네일)뿐이고, "notification" 키가 있는 payload는 background/terminated일 때
// 이 onMessageReceived 자체가 호출되지 않고 OS가 알아서 띄워버린다(코드로 못 막는
// OS 레벨 동작). 그래서 send-web-push/index.ts가 Android에는 완전 data-only(payload에
// "notification" 키 없음, title/body를 data 안에)로 보내도록 바꿨다 — 그래야 이
// onMessageReceived가 항상(foreground/background/terminated 전부) 호출된다.
public class MwhabitMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        // Capacitor 기본 처리(JS "pushNotificationReceived" 이벤트 발행, foreground 배너가
        // 이 이벤트를 듣는 lib/nativePush.ts 경로)는 그대로 유지한다.
        super.onMessageReceived(remoteMessage);

        // foreground면 위 JS 인앱 배너가 이미 사용자에게 보여주고 있으므로 여기서 시스템
        // 알림을 또 띄우면 동일 메시지가 중복 표시된다(Final Polish Batch 안전 규칙).
        // background/terminated일 때만 우리가 직접 만든다.
        if (MainActivity.isForeground) return;

        Map<String, String> data = remoteMessage.getData();
        String title = data.get("title");
        String body = data.get("body");
        if (title == null && body == null) return;

        showLargeIconNotification(remoteMessage, title != null ? title : "", body != null ? body : "");
    }

    private void showLargeIconNotification(RemoteMessage remoteMessage, String title, String body) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            boolean granted =
                ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
            if (!granted) return;
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        // remoteMessage.toIntent()가 채워주는 extras(google.message_id 포함, data 키 전부)를
        // 그대로 복사한다 — Capacitor의 PushNotificationsPlugin#handleOnNewIntent()가
        // "google.message_id" 키 존재로 알림 탭 진입을 판별해 "pushNotificationActionPerformed"를
        // 쏘므로, 이 extras를 그대로 둬야 기존 탭 핸들러(registerNativePushTapHandler)가
        // 회귀 없이 계속 동작한다.
        Intent sourceIntent = remoteMessage.toIntent();
        if (sourceIntent.getExtras() != null) {
            intent.putExtras(sourceIntent.getExtras());
        }

        int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingIntentFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent =
            PendingIntent.getActivity(this, (int) System.currentTimeMillis(), intent, pendingIntentFlags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, MainActivity.NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(0xFF0A2545)
            // @mipmap/ic_launcher는 API 26+에서 mipmap-anydpi-v26/ic_launcher.xml(adaptive-icon
            // XML, 래스터 아님)로 해석돼 BitmapFactory.decodeResource()가 null을 반환한다(실기기
            // 확인 — android.largeIcon=null로 조용히 빠짐, 예외도 없음). drawable-*dpi에 같은
            // 런처 PNG를 새 리소스명(anydpi-v26 별칭 없음)으로 복사해 항상 진짜 비트맵이
            // 나오게 한다 — 새 이미지 디자인 없이 기존 ic_launcher.png 그대로 재사용.
            .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.drawable.ic_notification_large_icon))
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(Notification.DEFAULT_VIBRATE);

        NotificationManagerCompat.from(this).notify((int) System.currentTimeMillis(), builder.build());
    }
}
