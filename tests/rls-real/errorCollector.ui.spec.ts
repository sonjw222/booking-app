/* Q02 회귀(브라우저 레벨): 수집기가 실제 Chromium 에서 API 500/403, 스크립트·이미지 로드 실패, pageerror 를 raw 로 빠짐없이 잡는지,
   알려진 규칙이 비슷한 실제 오류를 통과시키지 않는지, 끝나지 않는 로딩/오류 문구를 정상 시나리오에서 잡아내는지 확인한다.
   앱·DB 에 접속하지 않는다(가짜 origin 을 page.route 로 응답). */
import { expect, test, type Page } from "@playwright/test";
import { attachCollector, classify, waitForSettled, hasErrorUi, type KnownRule } from "./errorCollector";

const ORIGIN = "http://qa-fake.invalid";
async function servePage(page: Page, body: string) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    if (u.pathname === "/api/ok") return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    if (u.pathname === "/api/a") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    if (u.pathname === "/api/a2") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    if (u.pathname === "/api/forbidden") return route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
    if (u.pathname === "/missing.js" || u.pathname === "/broken.png") return route.abort("failed");
    return route.fulfill({ status: 404, body: "" });
  });
}
const PAGE_WITH_ERRORS = `<!doctype html><body><h1>t</h1>
<script>fetch('/api/a'); fetch('/api/a2'); fetch('/api/forbidden'); fetch('/api/ok');</script>
<script src="/missing.js"></script><img src="/broken.png">
<script>setTimeout(function(){ throw new Error('boom') }, 0)</script></body>`;

test("API 500·403, 스크립트/이미지 로드 실패, pageerror 가 규칙 없이는 전부 예상 밖으로 남는다", async ({ page }) => {
  await servePage(page, PAGE_WITH_ERRORS);
  const col = attachCollector(page, "/ @fake");
  await page.goto(ORIGIN + "/"); await page.waitForTimeout(500);
  const c = classify(col.events, []);
  const has = (f: (e: (typeof c.unexpected)[number]) => boolean) => c.unexpected.some(f);
  expect(has((e) => e.kind === "http" && e.status === 500 && e.path === "/api/a")).toBe(true);
  expect(has((e) => e.kind === "http" && e.status === 403 && e.path === "/api/forbidden")).toBe(true);
  expect(has((e) => e.kind === "requestfailed" && e.path === "/missing.js")).toBe(true);
  expect(has((e) => e.kind === "requestfailed" && e.path === "/broken.png")).toBe(true);
  expect(has((e) => e.kind === "pageerror" && e.text.includes("boom"))).toBe(true);
  expect(c.known).toBe(0); expect(c.raw).toBe(c.unexpected.length);
  expect(col.events.some((e) => e.path === "/api/ok")).toBe(false); // 성공 응답은 오류가 아니다
});

test("알려진 규칙은 대상 하나만 통과시키고, 상태·경로가 비슷한 실제 오류와 pageerror 는 통과시키지 않는다", async ({ page }) => {
  await servePage(page, PAGE_WITH_ERRORS);
  const col = attachCollector(page, "/ @fake");
  await page.goto(ORIGIN + "/"); await page.waitForTimeout(500);
  const rule: KnownRule = { id: "api-a", cause: "시험용 알려진 오류", kind: ["http"], status: 500, path: /^\/api\/a$/ };
  const c = classify(col.events, [rule]);
  expect(c.known).toBe(1); expect(c.knownByRule["api-a"].count).toBe(1);
  expect(c.unexpected.some((e) => e.path === "/api/a2" && e.status === 500)).toBe(true); // 비슷한 경로
  expect(c.unexpected.some((e) => e.path === "/api/forbidden")).toBe(true);
  expect(c.unexpected.some((e) => e.kind === "pageerror")).toBe(true);
});

test("정상 시나리오: 끝나지 않는 로딩과 오류 문구는 실패로 잡히고, 데이터·빈 상태는 통과한다", async ({ page }) => {
  await servePage(page, `<!doctype html><body><div class="loading-skeleton">loading</div></body>`);
  await page.goto(ORIGIN + "/");
  expect(await waitForSettled(page, 1500)).toBe(false); // 영원히 로딩

  await servePage(page, `<!doctype html><body><p>불러오지 못했어요. 잠시 후 다시 시도해 주세요</p></body>`);
  await page.goto(ORIGIN + "/");
  expect(await waitForSettled(page, 3000)).toBe(true);
  expect(await hasErrorUi(page)).toBe("불러오지 못했");               // 오류 문구는 별도로 잡힌다(레이아웃만 통과한 오류 화면 ≠ 정상)

  await servePage(page, `<!doctype html><body><div class="loading-skeleton" id="s">loading</div><script>setTimeout(function(){document.getElementById('s').remove();document.body.insertAdjacentHTML('beforeend','<p class="daylist-empty">등록된 항목이 없어요</p>')},300)</script></body>`);
  await page.goto(ORIGIN + "/");
  expect(await waitForSettled(page, 5000)).toBe(true);
  expect(await hasErrorUi(page)).toBeNull();                          // 정상 빈 상태
});
