package com.mwhabit.app;

import android.os.Bundle;
import android.view.View;
import androidx.activity.EdgeToEdge;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // registerPlugin()은 브릿지를 생성하는 super.onCreate() 이전에 호출해야 한다
        // (Capacitor 문서 관례 — BridgeActivity#load()가 super.onCreate() 안에서
        // bridgeBuilder로 Bridge를 만들기 때문).
        registerPlugin(AppSettingsPlugin.class);

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
        ViewCompat.setOnApplyWindowInsetsListener(contentRoot, (v, windowInsets) -> {
            Insets insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime()
            );
            v.setPadding(insets.left, insets.top, insets.right, insets.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
