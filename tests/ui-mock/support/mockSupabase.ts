/* Supabase REST/RPC/Auth 요청을 브라우저 단에서 가로채 고정 데이터로 응답한다(실제 서버 접속 없음). */
import type { Page, Route } from "@playwright/test";

export const REF = "abcdefghij0123456789";
export const CENTERS = [
  { id: "c-near", name: "하늘 요가 스튜디오", categories: ["요가"], intro: "도심 속 조용한 요가 공간", address: "서울 중구 세종대로 110", photo_url: null, latitude: 37.5745, longitude: 126.978, created_at: "2026-10-05T00:00:00Z" },
  { id: "c-mid", name: "가람 요가", categories: ["요가", "필라테스"], intro: "소규모 그룹 수업", address: "서울 성북구 보문로 12", photo_url: null, latitude: 37.606, longitude: 126.978, created_at: "2026-10-04T00:00:00Z" },
  { id: "c-far", name: "나무 요가 아카데미 — 매우 긴 센터 이름이 들어가도 레이아웃이 깨지지 않아야 합니다 한국어 센터명 테스트", categories: ["요가"], intro: null, address: "경기 고양시 덕양구 1", photo_url: null, latitude: 37.643, longitude: 126.978, created_at: "2026-10-03T00:00:00Z" },
  { id: "c-nocoord", name: "다온 요가", categories: ["요가"], intro: "위치 정보 없는 센터", address: null, photo_url: null, latitude: null, longitude: null, created_at: "2026-10-02T00:00:00Z" },
];
export const REVIEWS = [
  { center_id: "c-near", rating: 5 }, { center_id: "c-near", rating: 4 },
  { center_id: "c-far", rating: 5 }, { center_id: "c-far", rating: 5 }, { center_id: "c-far", rating: 4 },
];
const future = (days: number, hour = 19) => { const d = new Date(Date.now() + days * 86400_000); d.setUTCHours(hour - 9, 0, 0, 0); return d.toISOString(); };
export const CLASSES = [
  { id: "cls-1", center_id: "c-near", title: "아침 하타 요가", description: "호흡과 정렬에 집중하는 기본 하타 요가 수업이에요.\n초보자도 편하게 참여할 수 있어요.", class_format: "group", place: null, start_time: future(2, 7), end_time: future(2, 8), capacity: 10, status: "open", booking_deadline_min: 60, pass_selection_mode: "selected", rooms: { name: "A룸" }, centers: { name: "하늘 요가 스튜디오", categories: ["요가"], status: "approved" } },
  { id: "cls-2", center_id: "c-near", title: "아침 하타 요가", description: null, class_format: "group", place: null, start_time: future(9, 7), end_time: future(9, 8), capacity: 10, status: "open", booking_deadline_min: 60, pass_selection_mode: "all", rooms: null, centers: { name: "하늘 요가 스튜디오", categories: ["요가"], status: "approved" } },
  { id: "cls-3", center_id: "c-near", title: "저녁 빈야사", description: null, class_format: "private", place: "2층 스튜디오", start_time: future(3, 19), end_time: future(3, 20), capacity: 1, status: "open", booking_deadline_min: null, pass_selection_mode: "all", rooms: null, centers: { name: "하늘 요가 스튜디오", categories: ["요가"], status: "approved" } },
];

function tableOf(url: URL): string { return url.pathname.replace(/^\/rest\/v1\//, "").split("/")[0]; }
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

export type MockOpts = { manyCenters?: boolean; loggedIn?: boolean; hasPass?: boolean; failCenters?: boolean; noReviews?: boolean; reviewsFail?: boolean };
export const requests: string[] = [];

export async function mockSupabase(page: Page, opts: MockOpts = {}) {
  requests.length = 0;
  await page.route("**/*.supabase.co/**", async (route) => {
    const req = route.request(); const url = new URL(req.url());
    requests.push(`${req.method()} ${url.pathname}${url.search}`);
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (url.pathname.startsWith("/auth/v1/user")) return opts.loggedIn ? json(route, { id: "u1", aud: "authenticated", email: "mock@example.com", app_metadata: { provider: "email" }, user_metadata: {} }) : json(route, { msg: "no session" }, 401);
    if (url.pathname.startsWith("/auth/v1/")) return json(route, {});
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.split("/").pop();
      if (fn === "my_account_id") return json(route, opts.loggedIn ? "acc-1" : null);
      return json(route, []);
    }
    const t = tableOf(url);
    const q = url.searchParams;
    const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    const wrap = (rows: Record<string, unknown>[]) => (wantsObject ? (rows[0] ?? null) : rows);
    if (t === "centers") {
      if (opts.failCenters) return json(route, { message: "boom" }, 500);
      const idEq = q.get("id")?.replace("eq.", "");
      let rows: Record<string, unknown>[] = opts.manyCenters
        ? Array.from({ length: 24 }, (_, i) => ({ ...CENTERS[i % CENTERS.length], id: `c-${i}`, name: `센터 ${String(i).padStart(2, "0")}`, created_at: new Date(Date.now() - i * 1000).toISOString() }))
        : [...CENTERS];
      if (idEq) rows = rows.filter((c) => c.id === idEq).map((c) => ({ ...c, phone: null, sns: null, intro_blocks: [], pay_methods: null, review_point: 1000, status: "approved" }));
      return json(route, wrap(rows));
    }
    if (t === "center_reviews") { if (opts.reviewsFail) return json(route, { message: "boom" }, 500); return json(route, opts.noReviews ? [] : REVIEWS); }
    if (t === "classes") {
      const idEq = q.get("id")?.replace("eq.", "");
      if (idEq) { const row = CLASSES.find((c) => c.id === idEq); return json(route, wrap(row ? [row] : [])); }
      const title = q.get("title")?.replace("eq.", "");
      let rows = CLASSES.filter((c) => c.center_id === (q.get("center_id")?.replace("eq.", "") ?? c.center_id));
      if (title) rows = rows.filter((c) => c.title === title);
      return json(route, rows);
    }
    if (t === "class_reservation_counts") return json(route, CLASSES.map((c) => ({ class_id: c.id, confirmed_count: c.id === "cls-1" ? 4 : 0 })));
    if (t === "class_allowed_products") return json(route, [{ class_id: "cls-1", products: { name: "하타 10회권" } }, { class_id: "cls-1", products: { name: "기간제 1개월" } }]);
    if (t === "profiles") return json(route, opts.loggedIn ? [{ id: "p1" }] : []);
    if (t === "memberships") return json(route, opts.loggedIn && opts.hasPass ? [{ id: "m1", remaining_count: 5, expires_at: "2099-01-01", status: "active", products: { product_kind: "pass" } }] : []);
    return json(route, wrap([]));
  });
  if (opts.loggedIn) {
    await page.addInitScript(([ref]) => {
      const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u1", exp, role: "authenticated", aud: "authenticated" })}.sig`;
      localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify({ access_token: jwt, refresh_token: "r", expires_at: exp, expires_in: 3600, token_type: "bearer", user: { id: "u1", aud: "authenticated", email: "mock@example.com", app_metadata: { provider: "email" }, user_metadata: {} } }));
    }, [REF]);
  }
}
