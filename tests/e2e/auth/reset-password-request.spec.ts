import { test, expect } from "@playwright/test";

/*
  P1: 비밀번호 재설정 요청 화면(app/reset-password/page.tsx). 실제 이메일함을 확인할 수는
  없으므로(CI에 메일 API 연동 없음) 여기서는 "링크를 보냈다"는 화면 응답까지만 실브라우저로
  검증한다 — 실제로 링크를 눌러 새 비밀번호를 설정하는 것(app/reset-password/confirm)은
  수동 QA 체크리스트로 남긴다(최종 보고서 14번 항목).

  resetPasswordForEmail은 비밀번호를 바꾸지 않고 메일만 보내므로 공유 테스트 계정
  (TEST_USER_A)에 반복 실행해도 안전하다.
*/

test("이메일 입력 후 재설정 링크 보내기 — 성공 메시지 표시 (실브라우저)", async ({ page }) => {
  await page.goto("/reset-password");
  await page.locator('input[type="email"]').fill(process.env.TEST_USER_A_EMAIL!);
  await page.getByRole("button", { name: "재설정 링크 보내기" }).click();
  await expect(page.locator(".auth-msg.ok")).toBeVisible();
  await expect(page.locator(".auth-msg.ok")).toContainText("메일함을 확인해주세요");
});

test("이메일 미입력 시 클라이언트 유효성 검사로 막힌다 (실브라우저)", async ({ page }) => {
  await page.goto("/reset-password");
  await page.getByRole("button", { name: "재설정 링크 보내기" }).click();
  await expect(page.locator(".auth-msg.error")).toContainText("이메일을 입력해주세요");
});

test("로그인 화면의 '비밀번호를 잊으셨나요?' 링크로 이동한다 (실브라우저)", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "비밀번호를 잊으셨나요?" }).click();
  await expect(page).toHaveURL("/reset-password");
});
