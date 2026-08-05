import { expect, type Page } from "@playwright/test";

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

/*
  app/manager/settings/page.tsx 운영설정 화면 조작 헬퍼 — "운영설정 전체를 실제 관리자
  화면에서" 검증하라는 요구에 따라, admin(service-role) client로 center_settings를 직접
  덮어쓰는 대신 실제 화면의 입력/토글을 클릭해 저장한다.
*/

export async function gotoManagerSettings(page: Page): Promise<void> {
  await page.goto("/manager/settings");
  await page.locator(".settings-wrap").waitFor({ state: "visible" });
}

// 저장 버튼 상태 전이(저장 중 → 저장됨)로 저장 성공을 확인한다 — toast의 2.5초
// 자동소멸을 기다리지 않아도 된다(dirty가 false가 될 때까지 자동 재시도로 대기).
//
// ⚠ 직전에 fill()로 넣은 값이 화면에 이미 표시돼 있던 값과 문자열까지 완전히 같으면
// (예: 같은 분까지 계산된 kstTimeHHmm()을 연속 호출), React의 컨트롤드 인풋 값 추적기가
// "실제 변경 없음"으로 보고 onChange를 아예 안 띄워 dirty가 true로 안 바뀌는 경우가
// 있다(실제 CI에서 재현됨 — 저장 버튼이 disabled "저장됨" 상태로 그대로 남아 클릭이
// 계속 막힘). 이 경우는 애초에 저장할 변경사항이 없다는 뜻이므로 정상 성공으로 본다.
export async function saveManagerSettings(page: Page): Promise<void> {
  const btn = page.locator("button.header-action");
  const alreadySaved = (await btn.textContent())?.trim() === "저장됨" && (await btn.isDisabled());
  if (alreadySaved) return;
  await btn.click();
  await expect(btn).toHaveText("저장됨");
}

// "그룹 수업 예약"/"그룹 수업 취소"/"그룹 수업"(오픈 시점)처럼 "N일 전 HH:MM" 쌍으로 된
// 행을 조작한다. .set-label 텍스트 완전일치로 찾아 같은 이름을 가진 다른 섹션의 행과
// 헷갈리지 않게 한다(예: "그룹 수업 예약" vs 오픈 시점 섹션의 "그룹 수업").
export async function setDaysBeforeTime(page: Page, exactLabel: string, days: number, time: string): Promise<void> {
  const row = page.locator(".set-row.col").filter({ has: page.locator(".set-label", { hasText: new RegExp(`^${exactLabel}$`) }) });
  const daysInput = row.locator("input.set-num");
  await daysInput.fill(String(days));
  await daysInput.blur();
  await row.locator('input[type="time"]').fill(time);
}

// "당일 예약 허용"/"일일 예약 횟수 제한"처럼 켜고 끄는 토글 행을 조작한다.
export async function toggleSettingSwitch(page: Page, exactLabel: string, turnOn: boolean): Promise<void> {
  const row = page.locator(".set-row").filter({ has: page.locator(".set-label", { hasText: new RegExp(`^${exactLabel}$`) }) });
  const sw = row.locator("button.switch");
  const isOn = (await sw.getAttribute("class"))?.includes(" on") ?? false;
  if (isOn !== turnOn) await sw.click();
}

// "하루 최대"처럼 토글이 켜져야만 나타나는 숫자 입력 행을 조작한다.
export async function setSettingNumber(page: Page, exactLabel: string, value: number): Promise<void> {
  const row = page.locator(".set-row").filter({ has: page.locator(".set-label", { hasText: new RegExp(`^${exactLabel}$`) }) });
  const input = row.locator("input.set-num");
  await input.fill(String(value));
  await input.blur();
}
