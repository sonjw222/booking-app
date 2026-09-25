package com.mwhabit.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;
import android.graphics.Color;
import android.view.View;
import androidx.activity.EdgeToEdge;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // 백그라운드 heads-up 실기기 QA(2026-09-21) — Firebase Messaging이 앱에 커스텀
    // 채널 지정이 없으면 자동으로 만드는 fallback 채널(fcm_fallback_notification_channel)
    // 이 IMPORTANCE_DEFAULT(3)로 생성돼, 알림이 shade엔 들어가지만 heads-up 배너로는
    // 안 뜨는 걸 실기기 dumpsys notification으로 확인했다. 이 채널 ID는 이 상수와
    // AndroidManifest.xml의 default_notification_channel_id meta-data 양쪽에서 정확히
    // 일치해야 FCM이 fallback 대신 이 채널을 쓴다.
    public static final String NOTIFICATION_CHANNEL_ID = "mwhabit_default";

    // 알림 아이콘 실기기 QA(2026-09-21) — MwhabitMessagingService가 컬러 large icon 알림을
    // 직접 만들어 띄울지 판단하는 데 쓴다(foreground면 JS 배너가 이미 보여주므로 중복
    // 방지를 위해 시스템 알림을 만들지 않음, MwhabitMessagingService.java 참고).
    // ProcessLifecycleOwner 같은 새 의존성 없이 액티비티 하나짜리 구조를 그대로 이용 —
    // onStart/onStop이 "화면에 보이는 중"을 정확히 반영한다(onResume/onPause보다
    // 시스템 다이얼로그 등에 덜 민감).
    public static volatile boolean isForeground = false;

    @Override
    public void onStart() {
        super.onStart();
        isForeground = true;
    }

    @Override
    public void onStop() {
        super.onStop();
        isForeground = false;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // registerPlugin()은 브릿지를 생성하는 super.onCreate() 이전에 호출해야 한다
        // (Capacitor 문서 관례 — BridgeActivity#load()가 super.onCreate() 안에서
        // bridgeBuilder로 Bridge를 만들기 때문).
        registerPlugin(AppSettingsPlugin.class);
        registerPlugin(AndroidStatusBarBackgroundPlugin.class);
        // GoogleSignInPlugin.java — Google 네이티브 로그인(release blocker 대응,
        // 2026-09-15). iOS의 GoogleSignInPlugin.swift와 동일한 jsName/계약.
        registerPlugin(GoogleSignInPlugin.class);
        // CalendarEventPlugin.java — "캘린더에 추가"(2026-09-26). 시스템 캘린더 일정 추가 인텐트,
        // iOS의 CalendarEventPlugin과 동일한 jsName/계약(lib/calendarAdd.ts).
        registerPlugin(CalendarEventPlugin.class);

        // 채널 importance는 한 번 생성되면 코드로 다시 못 올린다(OS 정책 — 사용자가
        // 시스템 설정에서 직접 바꾸는 것만 허용). 이미 같은 ID로 만들어져 있으면
        // createNotificationChannel()은 그냥 no-op이라(공식 문서) 매 실행마다 불러도
        // 안전 — 앱을 한 번이라도 실행해야 채널이 생기므로 여기서 만든다.
        createHighImportanceNotificationChannel();

        // 실기기 QA(2026-09-14, 4차) — Android 15(API 35)부터 타깃 SDK 35+ 앱은 edge-to-edge가
        // 강제 적용되고, 타깃 SDK 36(API 36, 이 앱의 현재 targetSdkVersion)에서는 그 강제를
        // 끄는 옵트아웃(windowOptOutEdgeToEdgeEnforcement)조차 더 이상 동작하지 않는다
        // (Android 공식 문서, developer.android.com/about/versions/16/behavior-changes-16
        // #edge-to-edge 확인함) — 즉 "예전 방식(상태바 아래에서 콘텐츠 시작)으로 되돌리기"는
        // 이 앱 설정으로는 선택지가 아니다. 대신 공식 권장 방식대로 WebView 콘텐츠 영역에
        // 시스템 바(+키보드) 크기만큼 직접 padding을 줘서 겹침을 막는다 — CSS
        // env(safe-area-inset-*)는 iOS WKWebView와 달리 Android WebView에서 일관되게 채워진다는
        // 보장이 공식 문서로 확인되지 않아(불확실) 여기에 기대지 않는다. EdgeToEdge.enable()은
        // setContentView() 이전에 호출해야 하므로 super.onCreate() "이전"에 둔다(Capacitor의
        // BridgeActivity#onCreate가 그 안에서 setContentView를 호출함).
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);

        // setContentView() 이후(=super.onCreate() 완료 후)에만 콘텐츠 루트 뷰가 존재한다.
        // systemBars(상태바+내비게이션바)와 ime(키보드)를 하나의 리스너로 함께 처리 — 두
        // Type을 OR로 묶어 getInsets()에 넘기면 각 방향별로 더 큰 값이 자동으로 적용돼
        // (WindowInsetsCompat 공식 동작) 키보드가 열렸을 때 시스템 바 인셋과 따로 계산할
        // 필요가 없다. AndroidManifest.xml의 windowSoftInputMode="adjustResize"와 함께
        // 동작한다(Android 공식 키보드 마이그레이션 가이드 권장 조합).
        View contentRoot = findViewById(android.R.id.content);
        // Edge-to-edge exposes this padded view behind the transparent status bar.
        // Without an explicit surface the launch theme's navy remains visible.
        contentRoot.setBackgroundColor(Color.rgb(251, 251, 250));
        ViewCompat.setOnApplyWindowInsetsListener(contentRoot, (v, windowInsets) -> {
            Insets insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime()
            );
            v.setPadding(insets.left, insets.top, insets.right, insets.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }

    private void createHighImportanceNotificationChannel() {
        // 채널은 Android 8(API 26) 이상에만 존재하는 개념이다.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationChannel channel = new NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "모하빗 알림",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("예약, 수강권, 공지 등 모하빗 앱의 주요 알림이 이 채널로 와요.");
        channel.enableVibration(true);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }
}
