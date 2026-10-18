/* 격리 QA 실데이터 검증(실제 PostgreSQL + PostgREST). Mock이 아니다 — 질의 모양(임베드·범위 조회·RPC·view)과 집계가 실제로 동작하는지 본다. */
import { expect, test } from "@playwright/test";

const CAT = "/category/%EC%9A%94%EA%B0%80";
const C1 = "00000000-0000-4000-8000-000000000001";
const cls = (n: number) => `00000000-0000-4000-8000-0000000000c${n}`;

test.beforeEach(async ({ page }) => {
  page.on("response", (r) => { if (r.url().includes("/rest/v1/") && r.status() >= 400) throw new Error(`REST ${r.status()} ${r.url().slice(0, 140)}`); });
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

test("수업 상세: 실제 룸·강사 RPC·정원 view·허용 수강권·마감·다른 일정", async ({ page }) => {
  await page.goto(`/center/${C1}/class/${cls(1)}`);
  const facts = page.locator(".class-detail-facts");
  await expect(facts).toContainText("A룸");
  await expect(facts).toContainText("김하늘, 이가람");
  await expect(facts).toContainText("10명 · 6자리 남음");
  await expect(facts).toContainText("수업 시작 1시간 전까지 예약");
  await expect(page.locator(".class-detail-chips")).toContainText("하타 10회권");
  await expect(page.locator(".class-detail-chips")).toContainText("기간제 1개월");
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
