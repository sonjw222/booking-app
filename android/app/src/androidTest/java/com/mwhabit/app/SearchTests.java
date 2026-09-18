package com.mwhabit.app;

import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.web.webdriver.DriverAtoms.findElement;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webClick;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webKeys;
import static org.junit.Assert.assertTrue;

import androidx.test.espresso.Espresso;
import androidx.test.espresso.web.webdriver.Locator;
import androidx.test.ext.junit.rules.ActivityScenarioRule;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Automated QA Foundation Batch(2026-09-18) — 요청 2-D: 검색 화면 진입 + 입력 + 결과/empty
 * 상태 확인. 요청 3-F: 키보드 열림/닫힘도 같이 확인(UI Automator로 시스템 레벨 키보드
 * 표시 여부까지 — Espresso 자체는 키보드가 "화면에 실제로 보이는지"는 못 봄).
 */
@RunWith(AndroidJUnit4.class)
public class SearchTests {

    @Rule
    public ActivityScenarioRule<MainActivity> activityRule = new ActivityScenarioRule<>(MainActivity.class);

    @Test
    public void searchInputAndResults() {
        TestSupport.waitForInitialLoad();

        // app/page.tsx — <a class="searchbar" href="/search">
        assertTrue("홈 화면 검색 진입 링크(.searchbar)를 찾지 못함", TestSupport.webElementExists("a.searchbar"));
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "a.searchbar"))
            .perform(webClick());
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        // app/search/page.tsx — .search-input(placeholder="센터 이름 또는 종목 검색"),
        // .search-go(검색 버튼)
        assertTrue("검색 입력창(.search-input)을 찾지 못함", TestSupport.webElementExists(".search-input"));
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, ".search-input"))
            .perform(webClick())
            .perform(webKeys("필라테스"));

        // 요청 3-F(키보드 열림/닫힘) 관련 솔직한 한계 기록: UiDevice로 "키보드가 화면에
        // 실제로 떠 있는지" 정확히 판정하는 공식 API는 기기/OS 버전별 편차가 커(각
        // OEM의 소프트 키보드 창 이름이 다름, isScreenOn()은 화면 자체 on/off일 뿐
        // 키보드 표시 여부가 아님) 이 배치에서는 확정적인 assert를 넣지 않는다 — 아래
        // Espresso.pressBack()으로 "키보드를 닫는 동작" 자체는 수행하고, 그 뒤에도
        // 검색 입력이 유지되는지(화면이 안 깨지는지)만 결과 확인으로 간접 검증한다.
        // 정밀 판정이 필요하면 실기기 QA 체크리스트(사람 확인) 영역으로 남긴다
        // (docs/AUTOMATED_QA.md 참고).

        assertTrue("검색 실행 버튼(.search-go)을 찾지 못함", TestSupport.webElementExists(".search-go"));
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, ".search-go"))
            .perform(webClick());

        // 키보드 닫기(요청 3-F) — 결과 확인 전에 시스템 back으로 명시적으로 닫아본다.
        Espresso.pressBack();
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        // 검색 결과가 있으면 .search-center-row가, 없으면 EmptyState
        // (app/components/EmptyState.tsx — 실제 클래스명 .app-empty-state, 소스로 확인함)가
        // 뜬다(app/search/page.tsx 확인함) — 정확한 결과 개수는 테스트 데이터에 의존하므로
        // "화면이 멈추지 않고 둘 중 하나에 도달했는지"만 확인한다.
        boolean reachedSomeState =
            TestSupport.webElementExists(".search-center-row") || TestSupport.webElementExists(".app-empty-state");
        assertTrue("검색 실행 후 결과/empty 상태 어느 쪽에도 도달하지 못함", reachedSomeState);
    }
}
