import { test as setup, expect } from "@playwright/test";
import { MANAGER_AUTH_FILE, MEMBER_AUTH_FILE } from "./fixtures/authFiles";
import { switchToTestUser, saveTestAccountMeta } from "./fixtures/testData";

/*
  로그인 상태 저장(storageState) 전용 setup 프로젝트.
  - 매 테스트 파일마다 로그인 폼을 반복하지 않도록, 관리자/회원 두 계정으로 한 번씩만 실제
    로그인 폼을 통과해 브라우저 저장소(localStorage의 Supabase 세션)를 파일로 저장해둔다.
  - 이후 각 스펙 파일은 test.use({ storageState: MANAGER_AUTH_FILE }) 등으로 이 파일을 불러와
    로그인 화면을 거치지 않고 바로 로그인된 상태로 시작한다.
  - 절대로 기존 실제 계정을 새로 만들지 않는다 — TEST_MANAGER_A_EMAIL/TEST_USER_A_EMAIL은
    tests/integration의 통합 테스트와 완전히 같은, 이미 존재하는 테스트 전용 계정이다.

  ⚠️ 순서가 중요하다: 각 계정마다 "Node에서 switchToTestUser로 accountId/profileId만
  조회" → "그다음에 브라우저로 로그인"의 순서를 반드시 지킨다. 실제 CI 실행에서 이 순서를
  거꾸로(또는 이후 스펙 파일에서 같은 계정으로 Node가 다시 로그인) 했더니, 나중에 로그인한
  쪽이 이전 세션을 무효화해(Supabase 403 session_not_found, 트레이스로 확인) 브라우저
  세션이 깨졌다. 그래서 이제 이 두 계정으로 Node가 로그인하는 곳은 이 파일, 그것도 각
  계정당 브라우저 로그인 "직전" 단 한 번뿐이다 — 이후 어떤 스펙 파일도 이 두 계정으로
  다시 로그인하지 않는다(fixtures/testData.ts는 전부 admin client만 쓴다).
*/

async function loginAs(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  // "로그인" 텍스트는 상단 모드 탭(.mode-tab)에도 있어 getByRole은 두 요소에 걸린다
  // (strict mode violation, 실제 브라우저 실행으로 발견) — 제출 버튼만 명확히 지정한다.
  await page.locator("button.login-submit").click();
  // 로그인 성공 시 handleLogin()이 window.location.href = "/"로 이동시킨다.
  await page.waitForURL("/", { timeout: 15_000 });
}

setup("authenticate as manager (TEST_MANAGER_A)", async ({ page }) => {
  const managerA = await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  saveTestAccountMeta("manager-a", managerA);

  await loginAs(page, process.env.TEST_MANAGER_A_EMAIL!, process.env.TEST_MANAGER_A_PASSWORD!);
  await expect(page).toHaveURL("/");
  await page.context().storageState({ path: MANAGER_AUTH_FILE });
});

setup("authenticate as member (TEST_USER_A)", async ({ page }) => {
  const userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  saveTestAccountMeta("user-a", userA);

  await loginAs(page, process.env.TEST_USER_A_EMAIL!, process.env.TEST_USER_A_PASSWORD!);
  await expect(page).toHaveURL("/");
  await page.context().storageState({ path: MEMBER_AUTH_FILE });
});
