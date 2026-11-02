package com.mwhabit.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** NicepayAppReturn(순수 로직) JVM 단위 테스트 — lib/payments/nicepayAppReturn.ts · NicepayAppReturn.swift 와 같은 규칙. 실제 NICEPAY·기기 불필요. */
public class NicepayAppReturnTest {
    private static final String ORDER = "22222222-2222-4222-8222-222222222222";
    private static final String S = NicepayAppReturn.SCHEME;
    private static final String H = "mwhabit.com";

    @Test public void parsesExactFormsOnly() {
        NicepayAppReturn.Parsed w = NicepayAppReturn.parse(S + "://nicepay/wap?orderId=" + ORDER);
        assertNotNull(w); assertEquals(NicepayAppReturn.Kind.WAP, w.kind); assertEquals(ORDER, w.orderId);
        NicepayAppReturn.Parsed c = NicepayAppReturn.parse(S + "://nicepay/cancel?orderId=" + ORDER);
        assertNotNull(c); assertEquals(NicepayAppReturn.Kind.CANCEL, c.kind);
    }

    @Test public void rejectsForgedOrMalformed() {
        String[] bad = {
            "other://nicepay/wap?orderId=" + ORDER, S + "://evil/wap?orderId=" + ORDER, S + "://nicepay/other?orderId=" + ORDER, S + "://nicepay/?orderId=" + ORDER, S + "://nicepay?orderId=" + ORDER,
            S + "://nicepay/wap", S + "://nicepay/wap?orderId=", S + "://nicepay/wap?orderId=" + ORDER + "&x=1", S + "://nicepay/wap?x=1&orderId=" + ORDER, S + "://nicepay/wap?orderId=" + ORDER + "#f",
            S + "://user@nicepay/wap?orderId=" + ORDER, S + "://nicepay:80/wap?orderId=" + ORDER, S + "://nicepay/wap?orderId=AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", S + "://nicepay/wap?orderId=not-a-uuid",
            S + "://nicepay/wap?orderId=" + ORDER + "%0d%0a", S + "://nicepay/wap/../cancel?orderId=" + ORDER, " " + S + "://nicepay/wap?orderId=" + ORDER,
            S + "://nicepay/wap?orderId=" + ORDER + new String(new char[600]).replace('\0', 'a'),
            "javascript:alert(1)", "https://mwhabit.com/wap", "", null,
        };
        for (String u : bad) assertNull("거부해야 함: " + u, NicepayAppReturn.parse(u));
    }

    @Test public void resultPathIsOurResultScreenOnly() {
        assertEquals("/checkout/nicepay/result?orderId=" + ORDER + "&app=1", NicepayAppReturn.resultPath(NicepayAppReturn.parse(S + "://nicepay/wap?orderId=" + ORDER)));
        assertEquals("/checkout/nicepay/result?orderId=" + ORDER + "&app=1&cancel=1", NicepayAppReturn.resultPath(NicepayAppReturn.parse(S + "://nicepay/cancel?orderId=" + ORDER)));
    }

    @Test public void midPaymentWapDoesNotNavigate() {
        assertFalse(NicepayAppReturn.shouldNavigate(NicepayAppReturn.Kind.WAP, "https://pg-web.nicepay.co.kr/v3/x", H));
        assertFalse(NicepayAppReturn.shouldNavigate(NicepayAppReturn.Kind.WAP, "https://web.nicepay.co.kr/", H));
        assertFalse(NicepayAppReturn.shouldNavigate(NicepayAppReturn.Kind.WAP, "https://" + H + "/checkout?center=1", H));
        assertTrue(NicepayAppReturn.shouldNavigate(NicepayAppReturn.Kind.WAP, "https://" + H + "/", H));
        assertTrue(NicepayAppReturn.shouldNavigate(NicepayAppReturn.Kind.WAP, null, H));
        assertTrue(NicepayAppReturn.shouldNavigate(NicepayAppReturn.Kind.CANCEL, "https://pg-web.nicepay.co.kr/v3/x", H));
    }

    @Test public void paymentContextAndHostSpoofing() {
        assertTrue(NicepayAppReturn.isPaymentContext("https://pg-web.nicepay.co.kr/", H));
        assertFalse(NicepayAppReturn.isPaymentContext("https://" + H + "/login", H));
        assertFalse(NicepayAppReturn.isPaymentContext("https://evil-nicepay.co.kr.attacker.test/", H));
        assertFalse(NicepayAppReturn.isNicepayHost("nicepay.co.kr.evil.com"));
        assertFalse(NicepayAppReturn.isPaymentContext(null, H));
    }

    @Test public void schemeDecision() {
        assertEquals(NicepayAppReturn.SchemeDecision.OPEN_CARD_APP, NicepayAppReturn.decide("ispmobile", true));
        assertEquals(NicepayAppReturn.SchemeDecision.OPEN_CARD_APP, NicepayAppReturn.decide("KB-ACP", false));
        assertEquals(NicepayAppReturn.SchemeDecision.BLOCKED, NicepayAppReturn.decide("evilapp", true));
        assertEquals(NicepayAppReturn.SchemeDecision.NOT_APPLICABLE, NicepayAppReturn.decide("evilapp", false));
        for (String s : new String[] {"kakaotalk", "naversearchthirdlogin", "supertoss", "com.googleusercontent.apps.123", "kakao123", "https", "intent", "market"})
            assertEquals(s, NicepayAppReturn.SchemeDecision.NOT_APPLICABLE, NicepayAppReturn.decide(s, false));
        assertEquals(NicepayAppReturn.SchemeDecision.NOT_APPLICABLE, NicepayAppReturn.decide(null, true));
    }

    @Test public void intentTargetValidation() {
        assertTrue(NicepayAppReturn.isAllowedIntentTarget("com.kbcard.cxh.appcard", false, false, null));
        assertTrue(NicepayAppReturn.isAllowedIntentTarget("kvp.jjy.MispAndroid320", false, false, "android.intent.action.VIEW"));
        assertFalse(NicepayAppReturn.isAllowedIntentTarget("com.evil.app", false, false, null));                    // 허용 밖 패키지
        assertFalse(NicepayAppReturn.isAllowedIntentTarget(null, false, false, null));                               // 패키지 없음
        assertFalse(NicepayAppReturn.isAllowedIntentTarget("com.kbcard.cxh.appcard", true, false, null));            // component 지정
        assertFalse(NicepayAppReturn.isAllowedIntentTarget("com.kbcard.cxh.appcard", false, true, null));            // selector
        assertFalse(NicepayAppReturn.isAllowedIntentTarget("com.kbcard.cxh.appcard", false, false, "android.intent.action.CALL"));
        assertFalse(NicepayAppReturn.isAllowedIntentTarget("com.kakao.talk", false, false, null));                   // 로그인 앱은 목록 밖
        assertFalse(NicepayAppReturn.isSafeIntentDataScheme("file")); assertFalse(NicepayAppReturn.isSafeIntentDataScheme("content"));
        assertFalse(NicepayAppReturn.isSafeIntentDataScheme("javascript")); assertTrue(NicepayAppReturn.isSafeIntentDataScheme("kb-acp")); assertTrue(NicepayAppReturn.isSafeIntentDataScheme(null));
    }

    @Test public void marketOnlyForAllowedPackages() {
        assertEquals("com.kbcard.cxh.appcard", NicepayAppReturn.marketTargetPackage("market://details?id=com.kbcard.cxh.appcard"));
        assertEquals("kvp.jjy.MispAndroid320", NicepayAppReturn.marketTargetPackage("market://search?q=pname:kvp.jjy.MispAndroid320"));
        assertNull(NicepayAppReturn.marketTargetPackage("market://details?id=com.evil.app"));
        assertNull(NicepayAppReturn.marketTargetPackage("market://launch?id=com.kbcard.cxh.appcard"));
        assertNull(NicepayAppReturn.marketTargetPackage("market://details?id=com.kbcard.cxh.appcard&x=1"));
        assertNull(NicepayAppReturn.marketTargetPackage(null));
    }

    @Test public void allowlistsExcludeLoginApps() {
        for (String p : new String[] {"com.kakao.talk", "com.nhn.android.search", "viva.republica.toss", "com.nhnent.payapp"}) assertFalse(p, NicepayAppReturn.CARD_APP_PACKAGES.contains(p));
        for (String s : new String[] {"kakaotalk", "naversearchthirdlogin", "supertoss"}) assertFalse(s, NicepayAppReturn.CARD_APP_SCHEMES.contains(s));
        assertTrue(NicepayAppReturn.CARD_APP_SCHEMES.contains("ispmobile")); assertTrue(NicepayAppReturn.CARD_APP_PACKAGES.contains("kvp.jjy.MispAndroid320"));
    }
}
