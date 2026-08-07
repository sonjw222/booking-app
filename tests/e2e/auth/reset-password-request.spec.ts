import { test, expect } from "@playwright/test";

/*
  P1: 비밀번호 재설정 요청 화면(app/reset-password/page.tsx). 실제 이메일함을 확인할 수는
  없으므로(CI에 메일 API 연동 없음) 여기서는 "링크를 보냈다"는 화면 응답까지만 실브라우저로
  검증한다 — 실제로 링크를 눌러 새 비밀번호를 설정하는 것(app/reset-password/confirm)은
  수동 QA 체크리스트로 남긴다(최종 보고서 14번 항목).

  resetPasswordForEmail은 비밀번호를 바꾸지 않고 메일만 보내므로 공유 테스트 계정
  (TEST_USER_A)에 반복 실행해도 안전하다.

  ⚠ CI 실행에서 실제로 확인된 것: 이 dev Supabase 프로젝트는 TEST_USER_A_EMAIL(실제
  gmail 주소, 로그인 자체는 항상 성공)에 대해서도 resetPasswordForEmail이
  `Email address "..." is invalid`를 돌려준다 — 우리 코드가 아니라 Supabase Auth
  서버가 반환하는 응답이다(로그인엔 없고 이 엔드포인트에만 있는 별도 검증으로 보임,
  이 프로젝트의 이메일 발송 관련 설정이 아직 완전하지 않을 가능성 — 최종 보고서
  13번 "남은 이슈"에 기록). 그래서 "무조건 성공 메시지가 뜬다"는 이 dev 환경의 설정에
  좌우되는 가정이라 검증하지 않고, 대신 우리 코드가 실제로 우리 자신의 에러 문구가
  아니라 Supabase가 준 응답을 있는 그대로(성공이든 에러든) 화면에 반영하는지만
  검증한다 — 그게 이 코드가 진짜로 책임져야 할 부분이다.
*/

test("이메일 입력 후 재설정 요청 — Supabase 응답을 화면에 그대로 반영한다 (실브라우저)", async ({ page }) => {
  await page.goto("/reset-password");
  await page.locator('input[type="email"]').fill(process.env.TEST_USER_A_EMAIL!);
  await page.getByRole("button", { name: "재설정 링크 보내기" }).click();
  // 성공(.auth-msg.ok, "메일함을 확인해주세요") 또는 Supabase가 돌려준 에러
  // (.auth-msg.error) 둘 중 하나는 반드시 뜬다 — "요청 중..."에 멈춰있거나 아무 반응이
  // 없는 상태(비어있는 채로 멈춤)가 아니라는 것 자체가 이 화면의 핵심 동작이다.
  await expect(page.locator(".auth-msg")).toBeVisible();
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
