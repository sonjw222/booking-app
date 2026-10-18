/* 격리 QA 실데이터 검증(실제 PostgreSQL + PostgREST). Mock이 아니다 — 질의 모양(임베드·범위 조회·RPC·view)과 집계가 실제로 동작하는지 본다. */
import { expect, test } from "@playwright/test";

const CAT = "/category/%EC%9A%94%EA%B0%80";
const C1 = "00000000-0000-4000-8000-000000000001";
const cls = (n: number) => `00000000-0000-4000-8000-0000000000c${n}`;

// 예상하지 못한 REST 오류(4xx/5xx)는 실패로 본다. 예외 = 운영 권한 모델이 비로그인에게 일부러 거부하는 호출(강사 RPC 권한 오류)과, 이 최소 스키마에 없는 앱 공통 조회(로그인 세션 유지용 accounts/notifications 등).
const EXPECTED_DENIALS = [/\/rpc\/class_trainer_names/, /\/rest\/v1\/(accounts|notifications|profiles\?select=id&account_id)/];
test.beforeEach(async ({ page }) => {
  page.on("response", (r) => { if (r.url().includes("/rest/v1/") && r.status() >= 400 && !EXPECTED_DENIALS.some((re) => re.test(r.url()))) throw new Error(`REST ${r.status()} ${r.url().slice(0, 140)}`); });
});

test("종목 목록: 실제 후기 집계(2,500건 페이지 조회 포함)·평점 표시·평점 없는 센터·평점순", async ({ page }) => {
  const t0 = Date.now();
  await page.goto(`${CAT}?s=rating`);
  await expect(page.locator(".cat-center-card")).toHaveCount(5);
  await expect(page.locator(".cat-center-card", { hasText: "후기 많은 요가" }).locator(".cat-meta-rating")).toContainText("4.6");
  await expect(page.locator(".cat-center-card", { hasText: "후기 많은 요가" }).locator(".cat-meta-rating small")).toHaveText("(2500)");
  console.log(`RATINGS_RENDERED_MS ${Date.now() - t0}`);
  const names = await page.locator(".cat-center-name").allTextContents();
  expect(names.slice(0, 3).map((n) => n.slice(0, 2))).toEqual(["하늘", "후기", "나무"]);        // 4.7(3) > 4.6(2500) > 3.5(2), 평점 없는 센터(가람·다온)는 뒤
  await expect(page.locator(".cat-center-card", { hasText: "하늘 요가" }).locator(".cat-meta-rating")).toContainText("4.7");
  await expect(page.locator(".cat-center-card", { hasText: "나무 요가" }).locator(".cat-meta-rating")).toContainText("3.5");
  for (const n of ["가람 요가", "다온 요가"]) await expect(page.locator(".cat-center-card", { hasText: n }).locator(".cat-meta-rating")).toHaveCount(0);   // 0점으로 오해시키지 않는다
});

test("종목 목록: 실제 좌표 거리·반경 경계·좌표 없는 센터·URL 복원", async ({ page }) => {
  await page.goto(`${CAT}?s=distance`);
  await expect(page.locator(".cat-center-card")).toHaveCount(5);
  const dists = await page.locator(".cat-meta-distance").allTextContents();
  expect(dists.length).toBe(4);                                                          // 좌표 없는 다온은 거리 없음
  const km = dists.map((d) => (d.endsWith("km") ? parseFloat(d) : parseFloat(d) / 1000));
  expect([...km].sort((a, b) => a - b)).toEqual(km);                                     // 거리 오름차순
  await page.goto(`${CAT}?r=5`);
  await expect(page.locator(".cat-center-card")).toHaveCount(3);                           // 하늘 0.9km · 가람 4.4km · 후기 많은 요가 ≈4.9km(경계 안쪽) — 위치가 잡히면 반경이 적용된다
  const within = 3;
  const all = (await page.locator(".cat-center-name").allTextContents()).join("|");
  expect(all).not.toContain("다온 요가"); expect(all).not.toContain("나무 요가");       // 8.5km 밖 + 좌표 없음
  await page.reload(); await expect(page.locator(".cat-center-card")).toHaveCount(within);
});

test("수업 상세(비로그인): 실제 룸·정원 view·마감·다른 일정·상태별 안내 (강사/허용 수강권은 로그인 전용이라 아래 별도 테스트)", async ({ page }) => {
  await page.goto(`/center/${C1}/class/${cls(1)}`);
  const facts = page.locator(".class-detail-facts");
  await expect(facts).toContainText("A룸");
  await expect(facts).toContainText("10명 · 6자리 남음");
  await expect(facts).toContainText("수업 시작 1시간 전까지 예약");
  await expect(page.getByText("호흡과 정렬에 집중하는")).toBeVisible();
  await expect(page.locator(".class-detail-sessions a")).toHaveCount(1);                  // 같은 수업명의 다른 일정(c2)
  await page.goto(`/center/${C1}/class/${cls(3)}`);
  await expect(page.locator(".class-detail-facts")).toContainText("2층 스튜디오");
  await expect(page.locator(".class-detail-badge")).toHaveText("프라이빗 1:1");
  await page.goto(`/center/${C1}/class/${cls(4)}`);
  await expect(page.getByText("폐강된 수업이에요")).toBeVisible();
  await page.goto(`/center/${C1}/class/${cls(5)}`);
  await expect(page.locator(".class-detail-facts")).toContainText("정원 마감(대기 가능)");
  await page.goto(`/center/00000000-0000-4000-8000-000000000002/class/${cls(1)}`);    // 센터-수업 불일치
  await expect(page.getByText("수업을 찾을 수 없어요")).toBeVisible();
});

/* ---- 운영과 같은 권한 모델(anon 은 class_allowed_products 행이 보이지 않고 class_trainer_names 실행 불가)에서의 수업 상세 ---- */
import { execFileSync } from "node:child_process";
const SUB = "00000000-0000-4000-8000-0000000000f1";
const AUTHED = () => execFileSync("bash", ["tests/ui-real/run.sh", "token", "authenticated", SUB]).toString().trim();
const ANON = () => execFileSync("bash", ["tests/ui-real/run.sh", "token"]).toString().trim();
const API = "http://127.0.0.1:3201/rest/v1";

test("권한 모델 확인(PostgREST 직접): anon 은 허용 수강권 행 0개·강사 RPC 권한 오류, authenticated 는 둘 다 읽힌다", async ({ request }) => {
  const h = (t: string) => ({ apikey: t, Authorization: `Bearer ${t}` });
  const anonAllowed = await request.get(`${API}/class_allowed_products?select=class_id&class_id=eq.${cls(1)}`, { headers: h(ANON()) });
  expect(anonAllowed.status()).toBe(200); expect(await anonAllowed.json()).toEqual([]);                      // 오류가 아니라 "빈 배열" — 그래서 빈 결과를 '모두 가능'으로 읽으면 안 된다
  const anonRpc = await request.post(`${API}/rpc/class_trainer_names`, { headers: { ...h(ANON()), "content-type": "application/json" }, data: { p_class_ids: [cls(1)] } });
  expect([401, 403]).toContain(anonRpc.status()); expect((await anonRpc.json()).code).toBe("42501");
  const authAllowed = await request.get(`${API}/class_allowed_products?select=class_id&class_id=eq.${cls(1)}`, { headers: h(AUTHED()) });
  expect((await authAllowed.json()).length).toBe(2);
  const authRpc = await request.post(`${API}/rpc/class_trainer_names`, { headers: { ...h(AUTHED()), "content-type": "application/json" }, data: { p_class_ids: [cls(1)] } });
  expect((await authRpc.json()).map((r: { name: string }) => r.name)).toEqual(["김하늘", "이가람"]);
});

test("수업 상세(비로그인, 실제 anon 권한): 지정 수업의 허용 목록을 '모든 수강권 가능'으로 오인시키지 않고, 강사는 로그인 안내", async ({ page }) => {
  await page.goto(`/center/${C1}/class/${cls(1)}`);
  await expect(page.getByRole("heading", { level: 1, name: "아침 하타 요가" })).toBeVisible();
  await expect(page.getByTestId("allowed-passes-note")).toHaveText("이용 가능한 수강권은 로그인 후 확인해 주세요.");
  await expect(page.locator(".class-detail-v2")).not.toContainText("모든 수강권 가능");
  await expect(page.locator(".class-detail-facts")).toContainText("로그인 후 확인할 수 있어요");
  await expect(page.locator(".class-detail-facts")).toContainText("10명 · 6자리 남음");
  await page.goto(`/center/${C1}/class/${cls(2)}`);                                                            // all 모드 수업은 비로그인에서도 정확히 '모든 수강권 가능'
  await expect(page.locator(".class-detail-chips")).toContainText("모든 수강권 가능");
});

test("수업 상세(로그인, 실제 authenticated 권한): 허용 수강권·강사 표시", async ({ page }) => {
  const key = `sb-${new URL("http://127.0.0.1:3201").hostname.split(".")[0]}-auth-token`;
  const token = AUTHED();
  await page.addInitScript(([k, t, sub]) => { localStorage.setItem(k, JSON.stringify({ access_token: t, refresh_token: "r", expires_at: 4102444800, expires_in: 3600, token_type: "bearer", user: { id: sub, aud: "authenticated", email: "qa@example.com", app_metadata: { provider: "email" }, user_metadata: {} } })); }, [key, token, SUB]);
  await page.goto(`/center/${C1}/class/${cls(1)}`);
  await expect(page.locator(".class-detail-chips")).toContainText("하타 10회권");
  await expect(page.locator(".class-detail-chips")).toContainText("기간제 1개월");
  await expect(page.locator(".class-detail-facts")).toContainText("김하늘, 이가람");
  await expect(page.locator(".class-detail-v2")).not.toContainText("모든 수강권 가능");
  await expect(page.getByTestId("allowed-passes-note")).toHaveCount(0);
});

test("센터 상세(정상 센터): 센터명·공유·수강권 구매하기·예약하기가 실제로 표시된다('센터를 찾을 수 없어요'가 아니다)", async ({ page }) => {
  await page.goto(`/center/${C1}`);
  await expect(page.getByText("센터를 찾을 수 없어요")).toHaveCount(0);
  await expect(page.locator(".center-hero-name")).toHaveText("하늘 요가 스튜디오");
  await expect(page.getByRole("button", { name: "센터 공유" })).toBeVisible();
  await expect(page.getByRole("button", { name: "수강권 구매하기" }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "예약하기" })).toBeVisible();
});

test("후기 집계 페이지 조회: 정렬 키(order=id) 로 요청되고 2,500건이 중복·누락 없이 집계된다", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/rest/v1/center_reviews")) urls.push(r.url()); });
  await page.goto(CAT);
  await expect(page.locator(".cat-center-card", { hasText: "후기 많은 요가" }).locator(".cat-meta-rating small")).toHaveText("(2500)");
  expect(urls.length).toBeGreaterThanOrEqual(3);                                  // 1,000행 × 3 페이지
  for (const u of urls) expect(u).toContain("order=id.asc");
  expect(new Set(urls).size).toBe(urls.length);                                   // 같은 페이지를 두 번 읽지 않는다
});

test("정상 센터 상세: CTA 글자 대비(라이트/다크) ≥ 4.5, 공유 버튼 오른쪽 여백 = 헤더 gutter, 터치 영역 ≥ 44", async ({ page }) => {
  await page.goto(`/center/${C1}`);
  await expect(page.locator(".center-hero-name")).toHaveText("하늘 요가 스튜디오");
  const lum = (rgb: string) => { const [r, g, b] = rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t === "dark" ? "charcoal" : "burgundy"), theme);
    await page.waitForTimeout(500);
    for (const name of ["수강권 구매하기", "예약하기"]) {
      const [fg, bg] = await page.getByRole("button", { name }).last().evaluate((el) => { const c = getComputedStyle(el); return [c.color, c.backgroundColor]; });
      expect(ratio(fg, bg), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
      const box = (await page.getByRole("button", { name }).last().boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const [primary, border] = await page.locator(".center-bar-btn.primary").evaluate((el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.borderTopColor]; });
    const page_bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(Math.max(ratio(primary, page_bg), ratio(border, page_bg)), `${theme} 주 CTA 경계`).toBeGreaterThanOrEqual(3);   // 주 버튼의 채움 또는 경계가 페이지 배경과 3:1 이상(비텍스트 대비)
  }
  const share = (await page.getByRole("button", { name: "센터 공유" }).boundingBox())!;
  const shell = (await page.locator(".center-detail-v2").boundingBox())!;
  const gap = shell.x + shell.width - (share.x + share.width);
  expect(gap).toBeGreaterThanOrEqual(16); expect(share.width).toBeGreaterThanOrEqual(44); expect(share.height).toBeGreaterThanOrEqual(44);
});
