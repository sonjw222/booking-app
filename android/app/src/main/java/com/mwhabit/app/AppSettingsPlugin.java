package com.mwhabit.app;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 위치/알림 권한을 "다시 묻지 않음"으로 거부한 뒤에는 OS 런타임 권한 다이얼로그가 다시
 * 뜨지 않아 앱 안에서 재요청할 방법이 없다 — 유일한 복구 경로는 시스템 앱 설정 화면.
 * Capacitor 코어/@capacitor/push-notifications 어디에도 이걸 여는 API가 없어(공식
 * 플러그인이 아님) 이 최소 플러그인 하나만 추가한다. 웹 쪽에서는
 * lib/nativeAppSettings.ts가 감싸서 쓴다.
 */
@CapacitorPlugin(name = "AppSettings")
public class AppSettingsPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
