import { test, expect } from "@playwright/test";

/*
  P1(social-auth 배치): 소셜 로그인(Google/Kakao/Naver/Apple) 버튼의 앱 코드 동작 검증.

  실제 provider(Google/Kakao/Apple) OAuth 승인 화면까지 왕복하는 것은 이 개발용 Supabase
  프로젝트에 각 provider가 아직 콘솔에서 활성화돼 있지 않아 이 스펙만으로는 검증할 수 없다
  (AUTH_SETUP.md 참고).

  소셜 버튼 클릭 시 로딩 상태(중복 클릭/중복 콜백 실행 방지)는 signInWithOAuth()가 실제로
  전체 페이지 네비게이션을 일으키는 동작이라(fetch가 아님) Playwright에서 네트워크를 지연·
  중단시켜 "이동 중" 순간을 붙잡으려 하면 네비게이션 자체가 깨지면서 페이지가 통째로
  사라져(요소를 찾을 수 없음) 오히려 거짓 실패가 난다 — 그래서 이건 E2E로 자동 검증하지
  않고 코드 리뷰로 확인한다(app/login/page.tsx의 handleSocial: setSocialLoading은 await 전에
  동기로 실행돼 클릭 즉시 반영되고, `if (socialLoading) return`으로 중복 실행을 막는다).

  아래는 100% 앱 코드 안에서(실제 provider 왕복 없이) 확정적으로 검증 가능한 것만 남긴다 —
  홈 화면이 OAuth 콜백 실패(#error=...)를 감지해 /login?oauth_error=...로 정확히 안내하며
  되돌려보내는지. 실제 provider 왕복·성공 로그인은 최종 "사용자 수동 QA 체크리스트"에 남긴다.
*/

test("OAuth 콜백 실패(#error=...)로 홈에 도착하면 로그인 화면으로 안내 문구와 함께 되돌아간다 (실브라우저)", async ({ page }) => {
  await page.goto("/#error=access_denied&error_description=User+denied+access");
  await page.waitForURL(/\/login\?oauth_error=/, { timeout: 10_000 });
  await expect(page.locator(".auth-msg.error", { hasText: "소셜 로그인에 실패했어요" })).toBeVisible();
  await expect(page.locator(".auth-msg.error")).toContainText("User denied access");
});
