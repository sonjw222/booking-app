package com.mwhabit.app;

import java.net.URI;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * NICEPAY v3 앱(WebView) 결제 복귀·카드사 앱 호출 — 순수 로직(Android 클래스 의존 없음 → JVM 단위 테스트 가능).
 * lib/payments/nicepayAppReturn.ts · ios/App/App/NicepayAppReturn.swift 와 같은 규칙이다(tests/unit/nicepayNativeParity.test.ts 가 허용 목록·scheme·형식 동일성을 고정).
 *  - 복귀 URL 은 정확히 `<scheme>://nicepay/(wap|cancel)?orderId=<소문자 uuid>` 만 통과(다른 호스트·경로·추가 쿼리·fragment·userinfo·포트·대문자 UUID 거부).
 *  - 복귀 URL 이 왔다는 사실은 결제 성공이 아니다 — 결과 화면이 서버(DB 주문 상태)를 다시 묻는다. URL 에는 주문 UUID 외 비밀이 없다.
 *  - scheme 은 제안값(미확정): NICEPAY 기술지원 확인 + 사용자 승인 전에는 서버 설정이 꺼져 있어 WapUrl/IspCancelUrl 이 전송되지 않는다.
 * 허용 목록 출처: developers.nicepay.co.kr/docs/pg/add/app-webview(신용카드·공동인증·백신 구분). 소셜 로그인과 겹치는 앱(kakaotalk·네이버 등)은 의도적으로 제외.
 */
public final class NicepayAppReturn {
    private NicepayAppReturn() {}

    /** 제안 scheme(미확정). AndroidManifest.xml 의 data android:scheme 과 같아야 한다. */
    public static final String SCHEME = "mwhabitnicepay";
    public static final String HOST = "nicepay";
    public static final String ISP_PACKAGE = "kvp.jjy.MispAndroid320";

    /** 카드사·공동인증·백신 앱 패키지 허용 목록(intent:// 의 package 검증, market 폴백 대상, AndroidManifest queries 와 같은 목록). */
    public static final Set<String> CARD_APP_PACKAGES = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "kr.co.samsungcard.mpocket",
        "net.ib.android.smcard",
        "com.shcard.smartpay",
        "com.shinhancard.smartshinhan",
        "com.shinhan.smartcaremgr",
        "com.hyundaicard.appcard",
        "com.kbcard.cxh.appcard",
        "com.kbstar.kbbank",
        "com.kbstar.reboot",
        "kvp.jjy.MispAndroid320",
        "com.hanaskcard.paycla",
        "kr.co.hanamembers.hmscustomer",
        "com.lcacApp",
        "com.lottemembers.android",
        "nh.smart.nhallonepay",
        "com.wooricard.smartapp",
        "com.wooribank.smart.npib",
        "kr.co.citibank.citimobile",
        "com.kakaobank.channel",
        "com.hanaskcard.rocomo.potal",
        "com.lumensoft.touchenappfree",
        "com.TouchEn.mVaccine.webs",
        "com.ahnlab.v3mobileplus",
        "kr.co.shiftworks.vguardweb"
    )));

    /** 카드사 앱 custom scheme 허용 목록(소문자). */
    public static final Set<String> CARD_APP_SCHEMES = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "mpocket.online.ansimclick",
        "scardcertiapp",
        "monimopay",
        "monimopayauth",
        "shinhan-sr-ansimclick",
        "smshinhanansimclick",
        "hdcardappcardansimclick",
        "smhyundaiansimclick",
        "kb-acp",
        "kbbank",
        "newliiv",
        "ispmobile",
        "cloudpay",
        "hanaskcardmobileportal",
        "hanawalletmembers",
        "lotteappcard",
        "lottesmartpay",
        "lpayapp",
        "lmslpay",
        "nhappcardansimclick",
        "nhallonepayansimclick",
        "nonghyupcardansimclick",
        "wooripay",
        "com.wooricard.wcard",
        "newsmartpib",
        "citispay",
        "citimobileapp",
        "kakaobank",
        "qhanamopmoasign"
    )));

    public enum Kind { WAP, CANCEL }

    public static final class Parsed {
        public final Kind kind;
        public final String orderId;
        Parsed(Kind kind, String orderId) { this.kind = kind; this.orderId = orderId; }
    }

    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");

    public static boolean isValidOrderId(String s) { return s != null && UUID.matcher(s).matches(); }

    /** 복귀 URL 검증(문자열 수준으로 엄격히). 통과하지 못하면 null. */
    public static Parsed parse(String raw) {
        if (raw == null || raw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 500) return null;
        String prefix = SCHEME + "://" + HOST;
        if (!raw.startsWith(prefix + "/")) return null;
        String rest = raw.substring(prefix.length());   // "/wap?orderId=..."
        if (rest.contains("#")) return null;
        int q = rest.indexOf('?');
        if (q < 0) return null;
        String path = rest.substring(0, q), query = rest.substring(q + 1);
        Kind kind;
        if (path.equals("/wap")) kind = Kind.WAP; else if (path.equals("/cancel")) kind = Kind.CANCEL; else return null;
        if (!query.startsWith("orderId=")) return null;
        String id = query.substring("orderId=".length());
        if (!isValidOrderId(id)) return null;
        return new Parsed(kind, id);
    }

    /** 열 결과 화면 경로(상대) — 우리 서버의 결제 결과 화면뿐(외부 URL/토큰 없음). */
    public static String resultPath(Parsed p) {
        return "/checkout/nicepay/result?orderId=" + p.orderId + "&app=1" + (p.kind == Kind.CANCEL ? "&cancel=1" : "");
    }

    public static boolean isNicepayHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        return h.equals("nicepay.co.kr") || h.endsWith(".nicepay.co.kr");
    }

    private static String hostOf(String url) {
        try { return url == null ? null : new URI(url).getHost(); } catch (Exception e) { return null; }
    }
    private static String pathOf(String url) {
        try { String p = url == null ? null : new URI(url).getPath(); return p == null ? "" : p; } catch (Exception e) { return ""; }
    }

    /** 결제 문맥: WebView 가 NICEPAY 호스트이거나 앱의 /checkout 화면이다 — 이때만 허용 목록 밖 custom scheme 을 막는다(그 밖의 화면은 기존 Capacitor 동작 — 로그인 등 회귀 방지). */
    public static boolean isPaymentContext(String currentUrl, String appHost) {
        String h = hostOf(currentUrl);
        if (h == null) return false;
        h = h.toLowerCase(Locale.ROOT);
        if (isNicepayHost(h)) return true;
        return appHost != null && h.equals(appHost.toLowerCase(Locale.ROOT)) && pathOf(currentUrl).startsWith("/checkout");
    }

    /** 진행 중인 인증 흐름(NICEPAY·결제 화면)에서는 wap 복귀가 화면을 바꾸지 않는다(인증 → ReturnURL 승인 흐름을 끊지 않는다). 콜드 스타트·다른 화면이면 결과 화면으로. cancel 은 항상. */
    public static boolean shouldNavigate(Kind kind, String currentUrl, String appHost) {
        if (kind == Kind.CANCEL) return true;
        if (hostOf(currentUrl) == null) return true;
        return !isPaymentContext(currentUrl, appHost);
    }

    public enum SchemeDecision { NOT_APPLICABLE, OPEN_CARD_APP, BLOCKED }

    /** http/https/about/blob/data/file/intent/market 은 이 판정의 관심 밖(intent·market 은 플러그인이 따로 검증한다). */
    public static SchemeDecision decide(String urlScheme, boolean paymentContext) {
        if (urlScheme == null || urlScheme.isEmpty()) return SchemeDecision.NOT_APPLICABLE;
        String s = urlScheme.toLowerCase(Locale.ROOT);
        if (s.equals("http") || s.equals("https") || s.equals("about") || s.equals("blob") || s.equals("data") || s.equals("file") || s.equals("intent") || s.equals("market")) return SchemeDecision.NOT_APPLICABLE;
        if (CARD_APP_SCHEMES.contains(s)) return SchemeDecision.OPEN_CARD_APP;
        return paymentContext ? SchemeDecision.BLOCKED : SchemeDecision.NOT_APPLICABLE;
    }

    /** intent:// 로 넘어온 대상 패키지/구성 검증(Intent 를 파싱한 뒤 필드만 넘겨 검사). 허용 패키지이고 component·selector 가 없고 action 이 없거나 VIEW 일 때만 true. */
    public static boolean isAllowedIntentTarget(String pkg, boolean hasComponent, boolean hasSelector, String action) {
        if (pkg == null || !CARD_APP_PACKAGES.contains(pkg)) return false;
        if (hasComponent || hasSelector) return false;
        return action == null || action.equals("android.intent.action.VIEW");
    }

    /** data URI scheme 이 위험한 종류면 거부. */
    public static boolean isSafeIntentDataScheme(String dataScheme) {
        if (dataScheme == null) return true;
        String s = dataScheme.toLowerCase(Locale.ROOT);
        return !(s.equals("file") || s.equals("content") || s.equals("javascript") || s.equals("intent") || s.equals("android-app"));
    }

    /** market 이동 허용: 허용 패키지의 `market://details?id=<pkg>` 또는 `market://search?q=pname:<pkg>` 뿐. 허용이면 패키지명, 아니면 null. */
    public static String marketTargetPackage(String url) {
        if (url == null) return null;
        String pkg = null;
        if (url.startsWith("market://details?id=")) pkg = url.substring("market://details?id=".length());
        else if (url.startsWith("market://search?q=pname:")) pkg = url.substring("market://search?q=pname:".length());
        return pkg != null && CARD_APP_PACKAGES.contains(pkg) ? pkg : null;
    }
}
