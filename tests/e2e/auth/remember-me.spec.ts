import { test, expect } from "@playwright/test";

/*
  P1: "로그인 상태 유지"(remember me) 체크박스 — lib/supabaseClient.ts의 커스텀
  storage 어댑터가 REMEMBER_ME_KEY(localStorage, "0"일 때만) 기준으로 세션을
  localStorage 대신 sessionStorage에 저장한다. 체크 해제 시 실제로 브라우저 스토리지가
  바뀌는지 실브라우저로 검증한다.

  ⚠ auth.setup.ts의 경고와 동일한 이유로, 여기서는 Node 쪽 supabase 클라이언트로
  TEST_USER_A에 로그인하지 않는다(signOut(scope:'global')이 다른 스펙의 storageState
  세션을 무효화하는 문제) — 이 스펙은 오직 "새 브라우저 컨텍스트에서 로그인 폼을 직접
  제출"만 하고 Node에서는 로그인하지 않으므로 그 문제와 무관하다.
*/

test("로그인 상태 유지 체크 해제 시 세션이 localStorage가 아닌 sessionStorage에 저장된다 (실브라우저)", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");

  await page.locator('input[type="email"]').fill(process.env.TEST_USER_A_EMAIL!);
  await page.locator('input[type="password"]').fill(process.env.TEST_USER_A_PASSWORD!);
  await page.locator(".remember-me input").uncheck();
  await page.locator("button.login-submit").click();
  await page.waitForURL("/", { timeout: 15_000 });

  const authKeys = await page.evaluate(() => ({
    local: Object.keys(localStorage).filter((k) => k.startsWith("sb-") && k.includes("auth-token")),
    session: Object.keys(sessionStorage).filter((k) => k.startsWith("sb-") && k.includes("auth-token")),
  }));
  expect(authKeys.session.length).toBeGreaterThan(0);
  expect(authKeys.local.length).toBe(0);

  await context.close();
});

test("로그인 상태 유지 체크(기본값) 시 세션이 localStorage에 저장된다 (실브라우저)", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");

  await page.locator('input[type="email"]').fill(process.env.TEST_USER_A_EMAIL!);
  await page.locator('input[type="password"]').fill(process.env.TEST_USER_A_PASSWORD!);
  // 체크박스는 기본으로 켜져 있다 — 건드리지 않고 그대로 제출.
  await expect(page.locator(".remember-me input")).toBeChecked();
  await page.locator("button.login-submit").click();
  await page.waitForURL("/", { timeout: 15_000 });

  const authKeys = await page.evaluate(() => ({
    local: Object.keys(localStorage).filter((k) => k.startsWith("sb-") && k.includes("auth-token")),
  }));
  expect(authKeys.local.length).toBeGreaterThan(0);

  await context.close();
});
