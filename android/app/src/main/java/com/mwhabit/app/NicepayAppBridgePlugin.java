package com.mwhabit.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.Bridge;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;

/**
 * NICEPAY v3 앱(WebView) 결제 — 카드사/ISP 앱 호출과 모하빗 앱 복귀(Android). 순수 판정은 NicepayAppReturn.java, 이 파일은 Android/Capacitor 연결만 한다.
 *
 * Capacitor 기본 동작(Bridge.launchIntent): 허용(allowNavigation)되지 않은 이동은 모두 `new Intent(ACTION_VIEW, url)` 로 바깥에 넘긴다 — intent:// URI 는 이 방식으로 해석되지 않아 카드사 앱이 열리지 않고,
 * 임의 URL/scheme 이 검증 없이 실행된다. 이 플러그인은 Capacitor 의 shouldOverrideLoad 훅으로 "결제 문맥"에서만 이를 다듬는다:
 *  - intent://  : Intent.parseUri 후 허용 패키지(공식 문서 카드사·공동인증·백신)만, component/selector 없음, action 은 VIEW 뿐, 위험한 data scheme·extras·flags·추가 category 제거. 앱이 없으면 허용 패키지의
 *                 market://details 로만 안내(공식 샘플 방식). 허용 밖은 실행하지 않는다.
 *  - market://  : 허용 패키지 대상만(그 밖은 차단).
 *  - 카드사 custom scheme(ispmobile 등 허용 목록) : ACTION_VIEW(BROWSABLE) 로 열고, 열 앱이 없으면 안내(ISP 는 Play 스토어).
 *  - 결제 문맥(NICEPAY 호스트·/checkout 화면)에서 허용 목록 밖 custom scheme : 차단.
 *  - 그 밖의 이동(로그인 포함)은 null 을 돌려 Capacitor 기존 동작을 그대로 쓴다.
 * 결제를 성공/실패로 판단하지 않는다(서버 DB 상태만이 결과다).
 *
 * 복귀: MainActivity 가 우리 scheme(deep link)으로 열리면 handleReturn 을 부른다 — 검증을 통과한 URL 만, 열 화면은 서버(server.url)의 결제 결과 화면뿐, 같은 URL 3초 내 중복은 무시.
 */
@CapacitorPlugin(name = "NicepayAppBridge")
public class NicepayAppBridgePlugin extends Plugin {
    private static String lastUrl = null;
    private static long lastAtMs = 0;

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null || url.getScheme() == null) return null;
        Bridge b = getBridge();
        WebView wv = b == null ? null : b.getWebView();
        String appHost = b == null ? null : Uri.parse(b.getServerUrl() != null ? b.getServerUrl() : b.getAppUrl()).getHost();
        boolean ctx = NicepayAppReturn.isPaymentContext(wv == null ? null : wv.getUrl(), appHost);
        String scheme = url.getScheme().toLowerCase(java.util.Locale.ROOT);
        if (scheme.equals("intent")) { openIntentUrl(url.toString()); return true; }   // Capacitor 는 intent:// 를 해석하지 못하므로 항상 여기서 검증·처리
        if (scheme.equals("market")) {
            if (!ctx) return null;
            String pkg = NicepayAppReturn.marketTargetPackage(url.toString());
            if (pkg != null) openMarket(pkg);
            return true;
        }
        switch (NicepayAppReturn.decide(scheme, ctx)) {
            case OPEN_CARD_APP: openCardScheme(url); return true;
            case BLOCKED: return true;
            default: return null;
        }
    }

    private Context ctx() { return getActivity() != null ? getActivity() : getContext(); }

    private void toast(String msg) { Toast.makeText(ctx(), msg, Toast.LENGTH_LONG).show(); }

    private void openIntentUrl(String url) {
        Intent intent;
        try { intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME); } catch (URISyntaxException e) { return; }
        String pkg = intent.getPackage();
        if (!NicepayAppReturn.isAllowedIntentTarget(pkg, intent.getComponent() != null, intent.getSelector() != null, intent.getAction())) return;   // 허용 밖: 실행하지 않는다
        Uri data = intent.getData();
        if (!NicepayAppReturn.isSafeIntentDataScheme(data == null ? null : data.getScheme())) return;
        // 이 Intent 로는 "허용 패키지의 VIEW + BROWSABLE" 만 실행한다 — URI 가 실어 온 flags/extras/추가 category 는 모두 버린다.
        intent.setComponent(null); intent.setSelector(null); intent.setFlags(0); intent.replaceExtras((android.os.Bundle) null);
        List<String> cats = intent.getCategories() == null ? new ArrayList<String>() : new ArrayList<String>(intent.getCategories());
        for (String c : cats) intent.removeCategory(c);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        if (intent.getAction() == null) intent.setAction(Intent.ACTION_VIEW);
        try {
            ctx().startActivity(intent);
        } catch (ActivityNotFoundException e) {
            openMarket(pkg);   // 앱 미설치 → 허용 패키지의 스토어 페이지로만 안내
        }
    }

    private void openMarket(String pkg) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg));
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            ctx().startActivity(i);
        } catch (ActivityNotFoundException e) {
            toast("카드사 앱을 열 수 없어요. 앱을 설치한 뒤 다시 결제하거나 다른 결제 수단을 이용해주세요. 결제는 완료되지 않았어요.");
        }
    }

    private void openCardScheme(Uri url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, url);
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.setComponent(null); i.setSelector(null);
            ctx().startActivity(i);
        } catch (ActivityNotFoundException e) {
            if ("ispmobile".equalsIgnoreCase(url.getScheme())) openMarket(NicepayAppReturn.ISP_PACKAGE);
            else toast("카드사 앱이 설치되어 있지 않아요. 앱을 설치한 뒤 다시 결제하거나 다른 결제 수단을 이용해주세요. 결제는 완료되지 않았어요.");
        }
    }

    /** 우리 복귀 scheme 이면 true(처리했거나 무시했거나 — 다른 곳으로 넘기지 않는다). 아니면 false. */
    public static boolean handleReturn(final Uri uri, final Bridge bridge, boolean coldStart) {
        if (uri == null || uri.getScheme() == null || !uri.getScheme().equalsIgnoreCase(NicepayAppReturn.SCHEME)) return false;
        String raw = uri.toString();
        final NicepayAppReturn.Parsed parsed = NicepayAppReturn.parse(raw);
        if (parsed == null) return true;   // 형식 위반(위조 포함): 아무것도 하지 않는다
        long now = System.currentTimeMillis();
        if (raw.equals(lastUrl) && now - lastAtMs < 3000) return true;   // 중복 복귀
        lastUrl = raw; lastAtMs = now;
        if (bridge == null || bridge.getWebView() == null) return true;
        final boolean cold = coldStart;
        Runnable go = new Runnable() {
            @Override public void run() {
                WebView wv = bridge.getWebView();
                String server = bridge.getServerUrl() != null ? bridge.getServerUrl() : bridge.getAppUrl();
                if (wv == null || server == null) return;
                String appHost = Uri.parse(server).getHost();
                if (!NicepayAppReturn.shouldNavigate(parsed.kind, cold ? null : wv.getUrl(), appHost)) return;
                String base = server.endsWith("/") ? server.substring(0, server.length() - 1) : server;
                wv.loadUrl(base + NicepayAppReturn.resultPath(parsed));
            }
        };
        // 콜드 스타트: Capacitor 의 첫 로드가 끝난 뒤에 열어야 덮어써지지 않는다.
        if (cold) new Handler(Looper.getMainLooper()).postDelayed(go, 1000); else new Handler(Looper.getMainLooper()).post(go);
        return true;
    }
}
