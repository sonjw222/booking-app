import type { Page } from "@playwright/test";

/*
  브라우저 페이지 상호작용 헬퍼(테스트 데이터가 아니라 화면 조작 전용) — Node 쪽 DB
  헬퍼(testData.ts)와 분리해둔다.
*/

// app/reservation/page.tsx의 "오늘" 기본 선택(new Date().getDate() 등)은 브라우저의
// 로컬(시스템) 타임존을 쓴다 — 이 CI 러너는 UTC라서, KST 자정~오전 9시 사이에는 화면이
// "어제"를 기본으로 보여준다(실측 확인: 스크린샷에서 실행 시각이 KST 08/04 새벽인데도
// 화면은 08/03이 선택돼 있었음). 이건 운영 코드의 문제이지만 이번 배치에서는 고치지
// 않기로 했으므로, 테스트 쪽에서 캘린더를 실제 사용자처럼 클릭해 원하는 KST 날짜로
// 명시적으로 이동한다(임의 대기 없이, ‹/› 버튼과 날짜 셀 클릭만 사용).
export async function selectKstCalendarDay(page: Page, kstDate: string): Promise<void> {
  const [yearStr, monthStr, dayStr] = kstDate.split("-");
  const targetYear = Number(yearStr);
  const targetMonth = Number(monthStr);
  const targetDay = Number(dayStr);

  const navButtons = page.locator(".cal-month-nav button.cal-nav-btn");
  for (let guard = 0; guard < 24; guard++) {
    const headerText = (await page.locator(".cal-title").textContent())?.trim() ?? "";
    const [hy, hm] = headerText.split(".").map((n) => Number(n));
    if (hy === targetYear && hm === targetMonth) break;
    const targetIndex = targetYear * 12 + targetMonth;
    const currentIndex = hy * 12 + hm;
    if (targetIndex < currentIndex) {
      await navButtons.first().click(); // ‹ 이전 달
    } else {
      await navButtons.nth(1).click(); // › 다음 달
    }
  }

  // 같은 달 안에서는 날짜 숫자가 겹치지 않으므로(월 하나에 1~31이 한 번씩만 나옴)
  // .cal-daynum 텍스트 완전일치로 정확히 그 날짜 셀만 클릭한다.
  await page.locator(".cal-daynum", { hasText: new RegExp(`^${targetDay}$`) }).click();
}

// .toast는 showToast()가 2.5초 뒤 스스로 지운다(app/reservation/page.tsx) — 늦게 폴링을
// 시작하면 이미 사라진 뒤일 수 있다(실측으로 확인된 실패 원인). "나타나는 순간"을
// waitFor로 기다렸다가 그 즉시 텍스트를 읽어, 임의 sleep이나 뒤늦은 폴링 없이 안정적으로
// 확인한다.
export async function waitForToastText(page: Page, timeout = 15_000): Promise<string> {
  const toast = page.locator(".toast");
  await toast.waitFor({ state: "visible", timeout });
  return (await toast.textContent()) ?? "";
}
