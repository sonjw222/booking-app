import { expect, type Page } from "@playwright/test";
import { getFixtureAdminClient } from "../../integration/setup";

/*
  브라우저 페이지 상호작용 헬퍼(테스트 데이터가 아니라 화면 조작 전용) — Node 쪽 DB
  헬퍼(testData.ts)와 분리해둔다.
*/

// 데스크톱(768~1359px, hover 가능한 포인터)에서는 좌측 레일(.member-desktop-nav / .workspace-sidebar)이 포인터가 올라가면
// 88px → 244px로 "겹쳐서" 펼쳐진다(app/globals.css, app/workspace.css). Playwright의 포인터는 마지막 클릭 위치에 남아 있으므로
// (새 context는 (0,0) 근처), 레일 위에 포인터가 있는 채로 달력의 맨 왼쪽 열(일요일, x≈150~210)을 클릭하면 펼쳐진 레일이 그 칸을 덮어
// "<a/div> from <aside> subtree intercepts pointer events"로 60초 timeout이 난다 — 클릭하려는 날짜가 일요일이면 날짜에 따라 결정적으로 실패한다
// (2026-10-11/18이 일요일일 때 CI에서 관측, 로컬 재현 확인). 클릭 전에 포인터를 레일 밖(우측 가장자리)으로 치우고, 레일이 있으면
// :hover가 꺼질 때까지(폭 transition 0.22s는 Playwright 액션 가능성 검사가 기다린다) 확인한다. 임의 sleep/force 클릭은 쓰지 않는다.
export async function parkPointerOutsideRail(page: Page): Promise<void> {
  const vp = page.viewportSize();
  const x = Math.max(400, (vp?.width ?? 1280) - 30);
  await page.mouse.move(x, 100);
  await page.mouse.move(x - 10, 450);
  await expect
    .poll(
      () => page.evaluate(() => Array.from(document.querySelectorAll(".member-desktop-nav, .workspace-sidebar")).some((n) => n.matches(":hover"))),
      { message: "좌측 레일에 :hover가 남아 있음" },
    )
    .toBe(false);
}

// app/reservation/page.tsx의 "오늘" 기본 선택(new Date().getDate() 등)은 브라우저의
// 로컬(시스템) 타임존을 쓴다 — 이 CI 러너는 UTC라서, KST 자정~오전 9시 사이에는 화면이
// "어제"를 기본으로 보여준다(실측 확인: 스크린샷에서 실행 시각이 KST 08/04 새벽인데도
// 화면은 08/03이 선택돼 있었음). 이건 운영 코드의 문제이지만 이번 배치에서는 고치지
// 않기로 했으므로, 테스트 쪽에서 캘린더를 실제 사용자처럼 클릭해 원하는 KST 날짜로
// 명시적으로 이동한다(임의 대기 없이, ‹/› 버튼과 날짜 셀 클릭만 사용).
export async function selectKstCalendarDay(page: Page, kstDate: string): Promise<void> {
  await parkPointerOutsideRail(page);
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
// 사용자에게 보이는 "실패/차단 사유 메시지"를 기다려 텍스트를 돌려준다(이 헬퍼의 호출부는 전부 실패 사유를 확인한다).
// 대부분은 .toast지만, 예약 시트의 실패는 2026-09-29 이후(toUserMessage 적용) 시트 안의 인라인 알림(.booking-inline-error, role=alert)으로 보인다 — 서버 메시지(한글)는
// 그대로 통과한다. 직전에 성공한 동작의 토스트("예약이 완료됐어요!" 등, 2.5초 유지)가 아직 화면에 남아 있을 수 있어 그것을 실패 사유로 오인하지 않도록 성공 토스트는 무시한다.
const SUCCESS_TOAST = /완료됐어요|취소됐어요|저장했어요|대기 등록됐어요|저장됨/;
export async function waitForToastText(page: Page, timeout = 15_000): Promise<string> {
  let found = "";
  await expect.poll(async () => {
    const inline = page.locator(".booking-inline-error").first();
    if (await inline.isVisible()) { found = (await inline.textContent()) ?? ""; return true; }
    const toasts = page.locator(".toast");
    for (let i = 0; i < (await toasts.count()); i++) {
      const t = ((await toasts.nth(i).textContent()) ?? "").trim();
      if (t && !SUCCESS_TOAST.test(t)) { found = t; return true; }
    }
    return false;
  }, { timeout, message: "실패/차단 사유 메시지(.toast 또는 .booking-inline-error)가 나타나지 않음" }).toBe(true);
  return found;
}

/*
  app/manager/settings/page.tsx 운영설정 화면 조작 헬퍼 — "운영설정 전체를 실제 관리자
  화면에서" 검증하라는 요구에 따라, admin(service-role) client로 center_settings를 직접
  덮어쓰는 대신 실제 화면의 입력/토글을 클릭해 저장한다.
*/

export async function gotoManagerSettings(page: Page, centerId: string): Promise<void> {
  await page.goto("/manager/settings");
  await page.locator(".settings-wrap").waitFor({ state: "visible" });
  await selectManagerCenterChip(page, centerId);
}

/*
  센터 칩(.center-switcher .center-chip) 화면에서 테스트 센터를 이름으로 고른다 — 앱은 소속 센터가 둘 이상일 때만 칩을 그리고 기본은 목록 첫 센터다.
  테스트 센터 이름은 id 접미사로 유일하게 만들어져(setup.ts getOrCreateOwnedTestCenter) 정확 일치로 모호하지 않다. 센터가 하나면 아무것도 하지 않는다.
*/
export async function selectManagerCenterChip(page: Page, centerId: string): Promise<void> {
  const { data, error } = await getFixtureAdminClient().from("centers").select("name").eq("id", centerId).single();
  if (error || !data) throw new Error(`테스트 센터 이름 조회 실패: ${error?.message ?? "no data"}`);
  const chips = page.locator(".center-switcher .center-chip");
  await chips.first().waitFor({ state: "visible", timeout: 3000 }).catch(() => { /* 센터가 하나면 칩이 없다 */ });
  if ((await chips.count()) <= 1) return;
  const chip = chips.filter({ hasText: new RegExp(`^\\s*${data.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) });
  await expect(chip).toHaveCount(1);   // 이름이 유일해야 한다(모호하면 여기서 바로 실패)
  if ((await chip.getAttribute("class"))?.includes("on")) return;
  await chip.click();
  await expect(chip).toHaveClass(/\bon\b/);
  await page.waitForLoadState("networkidle");
}

export async function gotoManagerHolidays(page: Page, centerId: string): Promise<void> {
  await page.goto("/manager/holidays");
  await selectManagerCenterChip(page, centerId);
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
  // 저장 UI(app/manager/settings/page.tsx): 변경이 있으면 <button class="primary-btn">("변경사항 저장" → "저장 중"), 저장이 끝나 변경이 없으면
  // 버튼 대신 <span class="save-status" role="status">저장됨</span>으로 바뀐다(2026-10 이후). 예전에는 같은 버튼이 "저장됨"으로 바뀌었다.
  const saved = page.locator(".save-status", { hasText: "저장됨" });
  const saveBtn = page.locator("button.primary-btn");
  // 입력 직후에는 React가 다시 그리기 전이라 이전 "저장됨" 라벨이 잠깐 남아 있을 수 있다 — 그 순간 바로 성공으로 보면 실제로는 저장하지 않고 지나간다.
  // 변경이 있으면 저장 버튼이 나타나므로 그것을 기다리고, 끝까지 버튼이 안 나타나고 "저장됨"이면(위 ⚠: 같은 값이라 변경 없음) 정상 성공으로 본다.
  try {
    await saveBtn.waitFor({ state: "visible", timeout: 2000 });
  } catch {
    await expect(saved).toBeVisible();
    return;
  }
  await saveBtn.click();
  await expect(saved).toBeVisible();
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

/*
  관리자 수업 화면을 열고 "테스트가 만든 센터"를 앱의 공식 센터 선택기(select[aria-label="센터 선택"], option value = center id)로 명시 선택한다.
  앱은 소속 센터가 여러 개면 목록의 첫 센터(DB 반환 순서)를 기본으로 보여주므로, 같은 계정이 센터를 둘 이상 가지면(예: 이름이 같은 잔여 pending
  테스트 센터) 기본 센터가 테스트가 수업을 만든 센터와 달라져 `.class-row`를 못 찾고 60초 timeout이 난다(2026-10-07 dev에서 trace로 확인:
  UI는 manager_centers?center_id=eq.<pending 잔여> 를 조회, 수업은 승인된 센터에 생성됨). 이름이 같아도 id로 고르므로 모호하지 않다.
  센터가 하나뿐이면 기본이 이미 그 센터라 아무것도 바꾸지 않는다.
*/
export async function gotoManagerClasses(page: Page, centerId: string): Promise<void> {
  await page.goto("/manager/classes");
  await expect(page.locator(".cal-title")).toBeVisible();
  const select = page.getByLabel("센터 선택");
  await expect(select).toBeVisible();
  await page.waitForLoadState("networkidle");   // 기본 센터의 초기 로드가 끝난 뒤 바꾼다(늦게 도착한 기본 센터 응답이 덮어쓰는 경합 방지)
  if ((await select.inputValue()) !== centerId) {
    // 센터를 바꾸면 앱이 수업 목록과 수강권(products) 목록을 각각 다시 불러온다. 둘 다 끝나기 전에 "수업 등록"을 누르면 등록 폼이 이전 센터의 수강권 목록을
    // 스냅샷으로 잡아(openCreate) 다른 센터 상품으로 class_allowed_products를 넣다 RLS 위반이 난다(2026-10-07 trace로 확인) — 두 응답을 모두 기다린다.
    const isForCenter = (r: { url(): string }, table: string) => r.url().includes(`/rest/v1/${table}`) && r.url().includes(`center_id=eq.${centerId}`);
    const classesLoaded = page.waitForResponse((r) => isForCenter(r, "classes"));
    const productsLoaded = page.waitForResponse((r) => isForCenter(r, "products"));
    // 수강권 목록 체인(fetchProducts → setPassProducts → fetchRulesForProducts)의 마지막 단계가 예약조건 조회다 — 이 응답까지 와야 등록 폼이 새 센터 상품을 잡는다.
    const rulesLoaded = page.waitForResponse((r) => r.url().includes("/rest/v1/membership_schedule_rules"));
    await select.selectOption(centerId);
    await Promise.all([classesLoaded, productsLoaded, rulesLoaded]);
    await page.waitForLoadState("networkidle");
  }
  await expect(select).toHaveValue(centerId);
}

/*
  "수업 등록" 버튼 클릭 — 레이아웃별로 보이는 버튼이 다르다: 모바일/좁은 폭은 하단 FAB(.fab-btn), 태블릿·데스크톱 workspace 셸(2026-09-17 c1d4c18)은
  헤더 버튼(.workspace-create-class)이고 그 폭에서 .fab-btn은 CSS로 숨겨진다. 예전 스펙이 .fab-btn만 눌러 데스크톱 viewport(1280x720)에서
  "element is not visible"로 60초 timeout이 났다(PR CI의 admin UI 스펙 timeout 시작 시점과 일치). 지금 보이는 쪽을 누른다.
*/
export async function clickCreateClass(page: Page): Promise<void> {
  await page.locator(".workspace-create-class:visible, .fab-btn:visible").filter({ hasText: "수업 등록" }).first().click();
}
