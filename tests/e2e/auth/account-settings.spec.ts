import { test, expect } from "@playwright/test";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  P1: 내 정보 관리(app/mypage/info/page.tsx, 옛 app/settings/account 흡수) 화면 —
  마이페이지에서 진입할 수 있는지, 그리고 클라이언트 유효성 검사가 동작하는지만
  검증한다. 실제로 비밀번호를 성공적으로 바꾸는 것까지 실행하면 공유 테스트
  계정(TEST_USER_A)의 로그인 비밀번호 자체가 바뀌어 다른 모든 스펙(auth.setup.ts)이
  깨지므로, 성공 케이스는 절대 실행하지 않는다.
*/

test.use({ storageState: MEMBER_AUTH_FILE });

test("마이페이지 → 내 정보 관리 진입, 새 비밀번호 확인 불일치 시 막힌다 (실브라우저)", async ({ page }) => {
  await page.goto("/mypage");
  await page.getByRole("link", { name: "내 정보 관리" }).click();
  await expect(page).toHaveURL("/mypage/info");

  const passwordInputs = page.locator('input[type="password"]');
  await passwordInputs.nth(0).fill("aaaaaa1");
  await passwordInputs.nth(1).fill("bbbbbb2");
  await page.getByRole("button", { name: "비밀번호 변경" }).click();
  await expect(page.locator(".auth-msg.error")).toContainText("서로 달라요");
});

test("내 정보 관리 — 6자 미만 비밀번호는 막힌다 (실브라우저)", async ({ page }) => {
  await page.goto("/mypage/info");
  const passwordInputs = page.locator('input[type="password"]');
  await passwordInputs.nth(0).fill("abc");
  await passwordInputs.nth(1).fill("abc");
  await page.getByRole("button", { name: "비밀번호 변경" }).click();
  await expect(page.locator(".auth-msg.error")).toContainText("6자 이상");
});
