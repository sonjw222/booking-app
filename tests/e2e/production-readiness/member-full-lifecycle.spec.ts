import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { requireEnv, getFixtureAdminClient } from "../../integration/setup";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  getOrCreateTestPassProductNamed,
  createTestMembershipAdmin,
  fetchSettingsAdmin,
  saveSettingsAdmin,
  kstDateStr,
  type TestUser,
} from "../fixtures/testData";
import { MEMBER_B_AUTH_FILE } from "../fixtures/authFiles";
import { selectKstCalendarDay } from "../fixtures/pageHelpers";

/*
  프로덕션 출시 전 최종 QA — "신규 계정으로 처음부터 끝까지" 회원 생애주기 시나리오.

  이메일 회원가입 → 로그인 → 프로필 여러 개 생성 → 수강권 구매/발급 → 예약(계정 내
  프로필끼리 수강권을 공유해서 쓰는 실제 설계, fix_usable_memberships_shared.sql 확인 포함)
  → 취소/환급/대기승격 → 환불 → 프로필 삭제 → 계정 탈퇴까지 하나의 완전히 새로운 계정으로
  끊김없이 진행한다.

  ⚠ 이 파일이 검증하지 않는 것(구조적으로 자동화 불가, 별도 수동 QA 필요):
    - 구글/카카오/네이버 실제 OAuth 왕복(이 프로젝트 test Supabase 콘솔에 provider가
      비활성화돼 있음, tests/e2e/auth/social-login.spec.ts 상단 주석 참고)
    - 실제 카드번호 입력 결제 승인(토스 결제창은 iframe이라 카드입력 자동화가 불안정 —
      결제창이 열리는 시점까지는 tests/e2e/checkout/direct-payment.spec.ts 및 별도
      real-toss-gateway-open.spec.ts가 커버)
    - 웹 푸시 실제 수신, iPhone/Android 실기기 렌더링

  throwaway 계정: TEST_USER_A_EMAIL에 "+e2elifecycle" 서브주소를 붙여 새로 가입한다
  (tests/integration/auth-account-bootstrap.test.ts와 동일한 패턴). 이 프로젝트는 Confirm
  email이 꺼져 있어 signUp() 직후 바로 세션이 생기고, 실제 메일함 접근 없이도 끝까지
  진행할 수 있다.

  계정/프로필/멤버십/주문 정리는 이 시나리오의 **마지막 단계(계정 탈퇴)가 곧 정리**다 —
  탈퇴가 delete-account Edge Function으로 accounts/profiles를 포함해 정리한다. 이 파일이
  별도로 admin으로 지우는 건 시나리오 진행을 위해 만든 수업(class)뿐이다. 중간에 실패해
  탈퇴까지 못 가면 이 throwaway 계정이 남을 수 있다 — 그 경우 이메일로 다시 로그인해
  /mypage/info에서 수동으로 탈퇴 처리하면 된다.
*/

function throwawayCreds(suffix: string): { email: string; password: string } {
  const base = requireEnv("TEST_USER_A_EMAIL");
  const at = base.indexOf("@");
  const email = at >= 0 ? `${base.slice(0, at)}+${suffix}${base.slice(at)}` : `${suffix}-${base}`;
  return { email, password: requireEnv("TEST_USER_A_PASSWORD") };
}

// 이 시나리오는 마지막 단계(계정 탈퇴)가 곧 정리라서 평소엔 별도 cleanup이 필요 없지만,
// 중간에 실패하면 이 throwaway 계정이 auth.users에 그대로 남아 다음 실행의 signUp()이
// "이미 가입된 이메일이에요"로 막힌다 — 매번 시작 전에 이전 실행의 잔여물이 있으면
// 먼저 지운다(없으면 바로 반환, 조용히 통과).
async function cleanupThrowawayAccountIfExists(email: string, password: string): Promise<void> {
  const admin = getFixtureAdminClient();
  const scratch = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await scratch.auth.signInWithPassword({ email, password });
  if (error || !data.user) return; // 잔여 계정이 없으면(=이번이 첫 실행이거나 이미 정리됨) 할 일 없음
  const authId = data.user.id;
  await scratch.auth.signOut();

  const { data: account } = await admin.from("accounts").select("id").eq("auth_id", authId).maybeSingle();
  if (account) {
    const { data: profiles } = await admin.from("profiles").select("id").eq("account_id", account.id);
    const profileIds = (profiles ?? []).map((p: { id: string }) => p.id);
    if (profileIds.length > 0) {
      await admin.from("reservations").delete().in("profile_id", profileIds);
      await admin.from("memberships").delete().in("profile_id", profileIds);
      await admin.from("orders").delete().in("profile_id", profileIds);
      await admin.from("profiles").delete().in("id", profileIds);
    }
    await admin.from("accounts").delete().eq("id", account.id);
  }
  await admin.auth.admin.deleteUser(authId);
}

test.describe.configure({ mode: "serial" });

test("신규 계정 회원 생애주기: 가입→로그인→다중프로필→구매→예약/취소/대기승격→환불→탈퇴 (실브라우저)", async ({ browser }) => {
  test.setTimeout(180_000);

  const { email, password } = throwawayCreds("e2elifecycle");
  const phone = "010" + Date.now().toString().slice(-8); // accounts.phone으로 내 계정을 다시 찾기 위한 이번 실행 전용 고유값
  const managerA = loadTestAccountMeta("manager-a");
  const userB = loadTestAccountMeta("user-b");
  const centerId = await getOrCreateOwnedTestCenter(managerA as TestUser);
  const product = await getOrCreateTestPassProductNamed(centerId, "E2E 생애주기 테스트 수강권");
  // 대기승격 단계는 waitlist_weekly_limit=0(대기예약 미사용, 기본값)이면 아예 막힌다 —
  // 이 센터의 원래 설정을 기억해뒀다가 대기예약을 잠깐 켜고, 끝나면 원복한다.
  const originalSettings = await fetchSettingsAdmin(centerId);
  // 대기승격 단계에서 B가 실제로 대기 등록되려면(reserve_class는 대기 등록도 유효한 수강권을
  // 요구한다) B 몫의 수강권이 이 센터에 있어야 한다 — 다른 스펙이 우연히 남겨둔 상태에
  // 기대지 않고 이 테스트가 직접 보장한다.
  await createTestMembershipAdmin(centerId, userB.profileId, { remainingCount: 5 });
  await cleanupThrowawayAccountIfExists(email, password);

  const context = await browser.newContext();
  const page = await context.newPage();

  const capacityOneClass = await createFutureTestClassAdmin(centerId, {
    title: "E2E 생애주기 대기승격 테스트",
    hoursFromNow: 200,
    capacity: 1,
  });
  const bookableClass = await createFutureTestClassAdmin(centerId, {
    title: "E2E 생애주기 예약 테스트",
    hoursFromNow: 220,
    capacity: 8,
  });

  try {
    await test.step("회원가입: 신규 이메일로 일반 회원 가입", async () => {
      await page.goto("/login");
      await page.locator(".mode-tab", { hasText: "회원가입" }).click();
      await page.locator('input[placeholder="이름"]').fill("E2E 생애주기 회원");
      await page.locator('input[type="tel"]').fill(phone);
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(password);
      // 이용약관/개인정보처리방침 동의는 필수라 체크 안 하면 제출이 막힌다(app/login/page.tsx)
      await page.locator('.signup-agree-row input[type="checkbox"]').nth(0).check();
      await page.locator('.signup-agree-row input[type="checkbox"]').nth(1).check();
      await page.locator(".login-submit").click();
      await expect(page.locator(".auth-msg.ok")).toContainText("회원가입이 완료되었습니다", { timeout: 15_000 });
      // 가입 성공 후 자동으로 로그인 탭으로 전환된다(로그아웃된 상태) — 아직 홈으로 이동하지 않았어야 함
      await expect(page).toHaveURL(/\/login/);
    });

    await test.step("로그인: 방금 가입한 계정으로 로그인", async () => {
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(password);
      await page.locator(".login-submit").click();
      await page.waitForURL((u) => u.pathname === "/", { timeout: 15_000 });
    });

    await test.step("프로필 추가: 가족 프로필을 만들면 대표 프로필과 함께 2개가 된다", async () => {
      await page.goto("/profiles");
      await expect(page.locator(".profile-item")).toHaveCount(1); // 대표 프로필만 있는 초기 상태
      await page.locator(".add-profile-btn").click();
      await page.locator('input[placeholder="프로필 이름 (필수)"]').fill("가족 프로필");
      await page.locator(".add-profile-form .primary-btn", { hasText: "추가하기" }).click();
      await expect(page.locator(".profile-item")).toHaveCount(2, { timeout: 10_000 });
    });

    await test.step("대표 프로필은 삭제 버튼 자체가 없다(비대표만 삭제 가능)", async () => {
      const primaryItem = page.locator(".profile-item", { has: page.locator(".primary-badge") });
      await expect(primaryItem.locator(".profile-del")).toHaveCount(0);
      const familyItem = page.locator(".profile-item", { hasText: "가족 프로필" });
      await expect(familyItem.locator(".profile-del")).toHaveCount(1);
    });

    let myProfileId = "";
    await test.step("수강권 구매: 센터 상세에서 바로구매 → 직접결제(PG 미경유)로 주문 접수", async () => {
      // ⚠ 이 dev 환경은 .env.local에 NEXT_PUBLIC_PAYMENT_PROVIDER=toss가 실제로 켜져 있어
      // (Mock이 아님) 카드/카카오페이/토스페이/계좌이체를 고르면 실제 토스 결제창으로 리다이렉트
      // 된다 — 그 카드입력 자동화는 이 세션 전체에서 이미 범위 밖으로 정한 부분이라
      // (tests/e2e/checkout/direct-payment.spec.ts 상단 및 이전 대화 참고), 여기서는 PG를
      // 아예 거치지 않는 "직접결제"로 주문 접수 UI 자체만 실제로 검증한다.
      await page.goto(`/center/${centerId}?buy=1`);
      const row = page.locator(".center-product-row", { hasText: product.name });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.locator(".center-product-buy").click();
      await page.waitForURL(/\/checkout\?/, { timeout: 10_000 });
      await page.locator(".pay-method", { hasText: "직접결제" }).click();
      await expect(page.locator(".checkout-pay-btn")).toBeVisible({ timeout: 15_000 });
      await page.locator(".checkout-pay-btn").click();
      await expect(page.locator(".checkout-done-title")).toContainText("주문이 접수됐어요", { timeout: 15_000 });
    });

    await test.step("구매내역에 반영됐는지 확인 + 다운스트림(예약/취소/환불) 검증용 수강권을 관리자 발급으로 부여", async () => {
      await page.goto("/purchases");
      await expect(page.locator(".purchase-item", { hasText: product.name })).toBeVisible({ timeout: 15_000 });

      // 방금 만든 계정의 대표 프로필을 찾는다(phone은 이번 실행 전용 고유값이라 안전하게 매칭됨).
      const admin = getFixtureAdminClient();
      const { data: account, error: accErr } = await admin.from("accounts").select("id").eq("phone", phone).single();
      if (accErr || !account) throw new Error(`E2E 생애주기 테스트 계정 조회 실패: ${accErr?.message ?? "no data"}`);
      const { data: profile, error: profErr } = await admin
        .from("profiles").select("id").eq("account_id", account.id).eq("is_primary", true).single();
      if (profErr || !profile) throw new Error(`E2E 생애주기 테스트 대표 프로필 조회 실패: ${profErr?.message ?? "no data"}`);
      myProfileId = profile.id;

      // "직접결제" 주문은 매니저가 수동으로 확인해야 발급되는 pending 상태라(실제 결제 없음),
      // 아래 예약/취소/대기승격/환불 단계에 필요한 "실사용 가능한 수강권"은 이 방금 만든 주문과는
      // 별개로 관리자가 직접 발급한다(매니저 승인 UI 자체는 이 QA 배치 범위 밖).
      await createTestMembershipAdmin(centerId, myProfileId, { remainingCount: 5 });
    });

    await test.step("예약: 프로필이 여러 개면 계정 안의 수강권을 프로필끼리 공유해서 쓸 수 있다", async () => {
      // fix_usable_memberships_shared.sql(라이브 확정 로직) — 수강권은 "산 프로필 전용"이
      // 아니라 같은 계정의 모든 프로필이 공유하고, 실제로 처음 쓴 프로필에만 그 뒤로 묶인다.
      // 그래서 가족 프로필도 대표 프로필이 산 수강권으로 정상 예약된다(둘 다 거절되는 게
      // 아니라 계정 공유가 의도된 동작임을 검증한다).
      await page.goto("/reservation");
      await selectKstCalendarDay(page, kstDateStr(bookableClass.startTime));

      // 프로필이 2개 이상이라 프로필 선택 칩이 보여야 한다
      await expect(page.locator(".profile-picker")).toBeVisible({ timeout: 15_000 });

      const classRow = page.locator(".class-row", { hasText: "E2E 생애주기 예약 테스트" });
      await expect(classRow).toBeVisible({ timeout: 15_000 });
      await classRow.getByRole("button", { name: "예약" }).click();
      await page.getByRole("button", { name: "예약하기" }).click();
      await expect(page.locator(".toast")).toContainText("예약이 완료됐어요", { timeout: 10_000 });

      // 가족 프로필로 전환해서 같은 수업을 예약 — 같은 계정 공유 수강권으로 성공해야 한다
      await page.locator(".profile-picker-chips button", { hasText: "가족 프로필" }).click();
      await classRow.getByRole("button", { name: "예약" }).click();
      await expect(page.getByRole("button", { name: /^E2E 테스트 수강권/ })).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "예약하기" }).click();
      await expect(page.locator(".toast")).toContainText("가족 프로필 · 예약이 완료됐어요", { timeout: 10_000 });

      // 두 프로필 모두 각자의 예약이 남아있어야 한다
      await expect(classRow.getByRole("button", { name: "취소" })).toBeVisible({ timeout: 10_000 });
      await page.locator(".profile-picker-chips button", { hasText: "(나)" }).click();
      await expect(classRow.getByRole("button", { name: "취소" })).toBeVisible({ timeout: 10_000 });
    });

    await test.step("취소: 두 프로필 예약을 각각 취소하면 공유 수강권이 환급되고 알림함에 남는다", async () => {
      // .toast는 2.5초 뒤 스스로 사라지는 데다 연속으로 여러 번 뜨면 타이밍이 겹치기 쉬워서,
      // 여기서는 fleeting text 대신 구조적 결과(그 프로필의 "취소" 버튼이 "예약"으로 돌아오는지)로 확인한다.
      const classRow = page.locator(".class-row", { hasText: "E2E 생애주기 예약 테스트" });
      // 지금은 대표 프로필이 선택된 상태(직전 단계 마지막) — 대표 것부터 취소
      await classRow.getByRole("button", { name: "취소" }).click();
      await page.locator(".confirm-sheet").getByRole("button", { name: "확인" }).click();
      await expect(classRow.getByRole("button", { name: "예약" })).toBeVisible({ timeout: 10_000 });

      await page.locator(".profile-picker-chips button", { hasText: "가족 프로필" }).click();
      await classRow.getByRole("button", { name: "취소" }).click();
      await page.locator(".confirm-sheet").getByRole("button", { name: "확인" }).click();
      await expect(classRow.getByRole("button", { name: "예약" })).toBeVisible({ timeout: 10_000 });
      await page.locator(".profile-picker-chips button", { hasText: "(나)" }).click();

      await page.goto("/notifications");
      // trg_notify_reservation_update()가 취소 시 회원 본인에게도 알림을 보낸다(NOTIF-001)
      await expect(page.locator("text=예약이 취소됐어요").first()).toBeVisible({ timeout: 15_000 });
    });

    await test.step("대기예약 → 승격: 정원 1명 수업에 내가 먼저 예약하고, 다른 회원이 대기하다가 내가 취소하면 승격된다", async () => {
      // waitlist_weekly_limit=0(기본값)이면 대기예약 자체가 거부된다 — 이 단계 동안만 켠다.
      await saveSettingsAdmin(centerId, { ...originalSettings, waitlistWeeklyLimit: 10 });
      const waitlistDate = kstDateStr(capacityOneClass.startTime);
      await page.goto("/reservation");
      await selectKstCalendarDay(page, waitlistDate);
      const classRow = page.locator(".class-row", { hasText: "E2E 생애주기 대기승격 테스트" });
      await expect(classRow).toBeVisible({ timeout: 15_000 });
      await classRow.getByRole("button", { name: "예약" }).click();
      await page.getByRole("button", { name: "예약하기" }).click();
      await expect(page.locator(".toast")).toContainText("예약이 완료됐어요", { timeout: 10_000 });

      // 정원이 이미 찬 상태에서 TEST_USER_B가 같은 수업을 예약 시도 → 대기 등록돼야 한다
      // (정원이 차면 행 버튼 텍스트 자체가 "예약"에서 "대기"로 바뀐다, app/reservation/page.tsx)
      const bContext = await browser.newContext({ storageState: MEMBER_B_AUTH_FILE });
      const bPage = await bContext.newPage();
      try {
        await bPage.goto("/reservation");
        await selectKstCalendarDay(bPage, waitlistDate);
        const bRow = bPage.locator(".class-row", { hasText: "E2E 생애주기 대기승격 테스트" });
        await expect(bRow).toBeVisible({ timeout: 15_000 });
        await bRow.getByRole("button", { name: "대기" }).click();
        await bPage.getByRole("button", { name: "예약하기" }).click();
        await expect(bPage.locator(".toast")).toContainText("대기 등록됐어요", { timeout: 10_000 });
        await expect(bRow.locator(".booked-tag", { hasText: "대기중" })).toBeVisible({ timeout: 10_000 });

        // 내(정원 차지한 쪽)가 취소하면 대기 1순위(B)가 자동 승격돼야 한다
        await classRow.getByRole("button", { name: "취소" }).click();
        await page.locator(".confirm-sheet").getByRole("button", { name: "확인" }).click();
        await expect(page.locator(".toast")).toContainText("예약이 취소됐어요", { timeout: 10_000 });

        // reload()는 달력 선택 상태(React state)를 초기화하므로 날짜를 다시 선택해야 한다.
        await bPage.reload();
        await selectKstCalendarDay(bPage, waitlistDate);
        const bRowAfter = bPage.locator(".class-row", { hasText: "E2E 생애주기 대기승격 테스트" });
        await expect(bRowAfter.locator(".booked-tag", { hasText: "대기중" })).toHaveCount(0, { timeout: 15_000 });
        await expect(bRowAfter.getByRole("button", { name: "취소" })).toBeVisible({ timeout: 10_000 });

        // 정리: B의 승격된 예약도 취소해 다음 실행/다른 스펙에 영향 없게 한다
        await bRowAfter.getByRole("button", { name: "취소" }).click();
        await bPage.locator(".confirm-sheet").getByRole("button", { name: "확인" }).click();
        await expect(bPage.locator(".toast")).toContainText("예약이 취소됐어요", { timeout: 10_000 });
      } finally {
        await bContext.close();
      }
    });

    await test.step("환불: 구매한 수강권을 환불하면 구매내역에서 환불됨으로 바뀐다", async () => {
      await page.goto("/purchases");
      // 환불 대상은 실제로 예약/취소에 쓴, 관리자가 발급한 수강권이다(createTestMembershipAdmin이
      // product_name을 "E2E 테스트 수강권"으로 고정 — 위 "직접결제" 주문의 상품명과는 다름).
      const item = page.locator(".purchase-item", { hasText: "E2E 테스트 수강권" });
      await expect(item).toBeVisible({ timeout: 15_000 });
      await item.locator(".purchase-refund-btn", { hasText: "환불하기" }).click();
      await page.locator(".confirm-sheet").getByRole("button", { name: "환불하기" }).click();
      await expect(page.locator(".toast")).toContainText("환불 처리했어요", { timeout: 10_000 });
      await expect(item).toContainText("환불됨", { timeout: 10_000 });
    });

    await test.step("가족(비대표) 프로필은 정상적으로 삭제된다", async () => {
      await page.goto("/profiles");
      const familyItem = page.locator(".profile-item", { hasText: "가족 프로필" });
      await familyItem.locator(".profile-del").click();
      await page.locator(".confirm-sheet").getByRole("button", { name: "확인" }).click();
      await expect(page.locator(".profile-item")).toHaveCount(1, { timeout: 10_000 });
    });

    await test.step("계정 탈퇴: 탈퇴 후 로그인 화면으로 돌아가고, 같은 비밀번호로 다시 로그인할 수 없다", async () => {
      await page.goto("/mypage/info");
      await page.locator('input[placeholder="본인 확인을 위한 현재 비밀번호"]').fill(password);
      await page.locator(".danger-btn", { hasText: "탈퇴하기" }).click();
      await page.waitForURL(/\/login\?withdrawn=1/, { timeout: 20_000 });

      // 탈퇴된 계정으로 재로그인 시도 → 실패해야 한다(익명화 + auth.users 삭제)
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(password);
      await page.locator(".login-submit").click();
      await expect(page.locator(".auth-msg.error")).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(/\/login/);
    });
  } finally {
    await context.close();
    await saveSettingsAdmin(centerId, originalSettings);
    await cleanupTestClassAdmin(capacityOneClass.id);
    await cleanupTestClassAdmin(bookableClass.id);
  }
});
