import { test, expect } from "@playwright/test";

/*
  P1(social-auth 배치): 소셜 로그인(Google/Kakao/Naver/Apple) 버튼의 앱 코드 동작 검증.

  실제 provider(Google/Kakao/Apple) OAuth 승인 화면까지 왕복하는 것은 이 개발용 Supabase
  프로젝트에 각 provider가 아직 콘솔에서 활성화돼 있지 않아 이 스펙만으로는 검증할 수 없다
  (AUTH_SETUP.md 참고). signInWithOAuth()는 provider 설정 여부를 클라이언트에서 미리 알 수
  없어 실제로는 Supabase authorize 엔드포인트로 페이지 전체가 이동한 뒤에야 결과(성공 리다이렉트
  또는 에러)가 갈리므로, 여기서는 그 갈림 이후의 결과 문구까지는 단정하지 않고 다음만 검증한다:
    1) 클릭 즉시 로딩 상태가 켜지는지, 그 동안 다른 소셜 버튼도 비활성화되는지(중복 클릭/
       중복 콜백 실행 방지)
    2) 홈 화면이 OAuth 콜백 실패(#error=...)를 감지해 /login?oauth_error=...로 정확히
       안내하며 되돌려보내는지(이건 100% 앱 코드 안에서 일어나는 일이라 실provider 없이도
       확정적으로 검증 가능)
  실제 provider 왕복·성공 로그인은 최종 "사용자 수동 QA 체크리스트"에 남긴다.
*/

test("소셜 로그인 버튼 클릭 시 로딩 상태가 켜지고 다른 소셜 버튼도 함께 비활성화된다 (실브라우저)", async ({ page }) => {
  await page.goto("/login");

  // signInWithOAuth가 실제로 이동시키는 Supabase authorize 요청을 늦춰서 "로딩 중" 상태를
  // 확실히 관찰한다(이 요청은 fetch가 아니라 전체 페이지 네비게이션이지만 Playwright의
  // route()는 둘 다 가로챈다).
  await page.route("**/auth/v1/authorize**", async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.abort();
  });

  const kakaoBtn = page.locator(".social-btn.kakao");
  const googleBtn = page.locator(".social-btn.google");
  const naverBtn = page.locator(".social-btn.naver");
  const appleBtn = page.locator(".social-btn.apple");

  await expect(kakaoBtn).toBeVisible();
  await kakaoBtn.click();

  await expect(kakaoBtn).toContainText("이동 중...");
  await expect(kakaoBtn).toBeDisabled();
  await expect(googleBtn).toBeDisabled();
  await expect(naverBtn).toBeDisabled();
  await expect(appleBtn).toBeDisabled();
});

test("OAuth 콜백 실패(#error=...)로 홈에 도착하면 로그인 화면으로 안내 문구와 함께 되돌아간다 (실브라우저)", async ({ page }) => {
  await page.goto("/#error=access_denied&error_description=User+denied+access");
  await page.waitForURL(/\/login\?oauth_error=/, { timeout: 10_000 });
  await expect(page.locator(".auth-msg.error", { hasText: "소셜 로그인에 실패했어요" })).toBeVisible();
  await expect(page.locator(".auth-msg.error")).toContainText("User denied access");
});
