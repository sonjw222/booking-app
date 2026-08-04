import { test, expect } from "@playwright/test";
import { loadTestAccountMeta, getOrCreateOwnedTestCenter, type TestUser } from "../fixtures/testData";
import { MANAGER_AUTH_FILE } from "../fixtures/authFiles";
import { gotoManagerSettings } from "../fixtures/pageHelpers";

/*
  [진단 전용, 임시] Playwright 관리자 세션 session_not_found 조사 — 1단계(A):
  이 파일 전체에서 MANAGER_AUTH_FILE로 여는 BrowserContext는 정확히 "1개"뿐이다(다른
  스펙 파일과 동시에 돌지 않도록 이 파일 하나만 CI에서 실행). 이 조건에서도
  session_not_found가 재현되면 "여러 context가 같은 storageState를 동시에/순차로 재사용"
  가설은 배제되고, auth.setup.ts 자체 또는 그 이전 시점에 이미 세션이 무효화됐다는 뜻이다.

  auth 상태 변화(TOKEN_REFRESHED/SIGNED_OUT/INITIAL_SESSION 등)를 브라우저 콘솔로
  로그해 Node 쪽(Playwright 리포터)으로 전달한다 — 토큰 원문은 출력하지 않고 이벤트
  종류와 만료시각(exp)만 출력한다.
*/

test.use({ storageState: MANAGER_AUTH_FILE });

let managerA: TestUser;
let centerAId: string;

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
});

test("[진단] 단일 관리자 context — /manager/settings 접근 시 세션 상태", async ({ page }) => {
  page.on("console", (msg) => {
    if (msg.text().startsWith("[AUTH-DIAG]")) console.log(msg.text());
  });

  await page.addInitScript(() => {
    (window as any).__authEvents = [];
  });

  // 페이지 로드 후, 이미 로드된 supabase 클라이언트의 onAuthStateChange를 구독해서
  // 이벤트 종류 + exp(토큰 원문 아님)만 콘솔로 남긴다. app 코드가 window에 클라이언트를
  // 노출하지 않으므로, localStorage에 저장된 세션의 expires_at만 직접 읽어 진단한다.
  await page.goto("/manager/settings");

  const sessionInfo = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.includes("supabase") || k.includes("auth-token"));
    const out: Record<string, any> = {};
    for (const k of keys) {
      try {
        const parsed = JSON.parse(localStorage.getItem(k) || "{}");
        out[k] = {
          hasAccessToken: !!parsed?.access_token,
          hasRefreshToken: !!parsed?.refresh_token,
          expiresAt: parsed?.expires_at,
          userId: parsed?.user?.id ? String(parsed.user.id).slice(0, 8) + "…" : null,
        };
      } catch {
        out[k] = "unparseable";
      }
    }
    return out;
  });
  console.log("[AUTH-DIAG] localStorage session summary (redacted): " + JSON.stringify(sessionInfo));

  const bodyText = await page.locator(".back-header .title").textContent().catch(() => null);
  console.log("[AUTH-DIAG] page title after goto: " + bodyText);

  const emptyState = page.locator(".daylist-empty");
  const settingsWrap = page.locator(".settings-wrap");
  await Promise.race([
    emptyState.waitFor({ state: "visible", timeout: 15000 }).catch(() => null),
    settingsWrap.waitFor({ state: "visible", timeout: 15000 }).catch(() => null),
  ]);
  const emptyVisible = await emptyState.isVisible().catch(() => false);
  const wrapVisible = await settingsWrap.isVisible().catch(() => false);
  console.log(`[AUTH-DIAG] emptyStateVisible=${emptyVisible} settingsWrapVisible=${wrapVisible}`);

  expect(wrapVisible || emptyVisible).toBe(true);
});
