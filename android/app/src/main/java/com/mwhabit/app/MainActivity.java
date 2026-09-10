package com.mwhabit.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // registerPlugin()은 브릿지를 생성하는 super.onCreate() 이전에 호출해야 한다
        // (Capacitor 문서 관례 — BridgeActivity#load()가 super.onCreate() 안에서
        // bridgeBuilder로 Bridge를 만들기 때문).
        registerPlugin(AppSettingsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
