import { test as base, type Page } from "@playwright/test";
import { MANAGER_AUTH_FILE } from "./authFiles";

/*
  관리자 세션 session_not_found 조사 결과(1단계 A/B, CI 실측):
  - MANAGER_AUTH_FILE(storageState 스냅샷)을 여는 BrowserContext가 정확히 1개뿐인
    조건(_diag-single-manager-context.spec.ts)에서는 재현되지 않았다(Green).
  - 이전에는 서로 다른 스펙 파일/테스트마다 test.use({storageState: MANAGER_AUTH_FILE})
    또는 browser.newContext({storageState: MANAGER_AUTH_FILE})로 같은 스냅샷 파일을
    최대 6번까지 각자 새 BrowserContext에 "복사"해 로드했다 — 이 여러 context 중 하나가
    최초로 실제 요청을 보내면서 Supabase가 리프레시 토큰을 회전시키고, 그 이후 같은
    "낡은" 스냅샷을 로드한 다른 context들은 이미 무효화된 토큰을 쓰게 돼
    403 session_not_found를 겪었을 가능성이 가장 유력하다(정황 증거: workers=1/
    fullyParallel=false라 "동시 실행"은 아예 불가능했고, 실패는 항상 여러 context가
    누적된 이후 나타났다).

  수정: worker-scoped fixture로 바꿔 이 워커(=이 CI 잡 전체, workers=1이므로 사실상
  전체 실행 동안) MANAGER_AUTH_FILE을 여는 BrowserContext를 "정확히 1개"만 만들고,
  이를 필요로 하는 모든 스펙/테스트가 그 하나의 살아있는 page를 재사용한다 — 다시는
  같은 스냅샷을 여러 context에 나눠 로드하지 않는다.
*/

export const test = base.extend<{}, { managerPage: Page }>({
  managerPage: [
    async ({ browser }, use) => {
      const context = await browser.newContext({ storageState: MANAGER_AUTH_FILE });
      const page = await context.newPage();
      await use(page);
      await context.close();
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
