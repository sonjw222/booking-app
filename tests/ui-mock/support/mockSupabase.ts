/* Supabase REST/RPC/Auth 요청을 브라우저 단에서 가로채 고정 데이터로 응답한다(실제 서버 접속 없음). */
import type { Page, Route } from "@playwright/test";

export const REF = "abcdefghij0123456789";
export const CENTERS = [
  { id: "c-near", name: "하늘 요가 스튜디오", categories: ["요가"], intro: "도심 속 조용한 요가 공간", address: "서울 중구 세종대로 110", photo_url: null, latitude: 37.5745, longitude: 126.978, created_at: "2026-10-05T00:00:00Z" },
  { id: "c-mid", name: "가람 요가", categories: ["요가", "필라테스"], intro: "소규모 그룹 수업", address: "서울 성북구 보문로 12", photo_url: null, latitude: 37.606, longitude: 126.978, created_at: "2026-10-04T00:00:00Z" },
  { id: "c-far", name: "나무 요가 아카데미 — 매우 긴 센터 이름이 들어가도 레이아웃이 깨지지 않아야 합니다 한국어 센터명 테스트", categories: ["요가"], intro: null, address: "경기 고양시 덕양구 1", photo_url: null, latitude: 37.643, longitude: 126.978, created_at: "2026-10-03T00:00:00Z" },
  { id: "c-nocoord", name: "다온 요가", categories: ["요가"], intro: "위치 정보 없는 센터", address: null, photo_url: null, latitude: null, longitude: null, created_at: "2026-10-02T00:00:00Z" },
];
export const LONG_ADDR_CENTER = { id: "c-longaddr", name: "긴주소센터", categories: ["요가"], intro: null, address: "경상북도울릉군울릉읍도동리독도이사부길가나다라마바사아자차카타파하긴주소 1", photo_url: null, latitude: 37.57, longitude: 126.98, created_at: "2026-10-02T12:00:00Z" };
export const REVIEWS = [
  { center_id: "c-near", rating: 5 }, { center_id: "c-near", rating: 4 },
  { center_id: "c-far", rating: 5 }, { center_id: "c-far", rating: 5 }, { center_id: "c-far", rating: 4 },
];
export const FAR_CLASS_DAYS = 75;
const future = (days: number, hour = 19) => { const d = new Date(Date.now() + days * 86400_000); d.setUTCHours(hour - 9, 0, 0, 0); return d.toISOString(); };
export const CLASSES = [
  { id: "cls-1", center_id: "c-near", title: "아침 하타 요가", description: "호흡과 정렬에 집중하는 기본 하타 요가 수업이에요.\n초보자도 편하게 참여할 수 있어요.", class_format: "group", place: null, start_time: future(2, 7), end_time: future(2, 8), capacity: 10, status: "open", booking_deadline_min: 60, pass_selection_mode: "selected", rooms: { name: "A룸" }, centers: { name: "하늘 요가 스튜디오", categories: ["요가"], status: "approved" } },
  { id: "cls-2", center_id: "c-near", title: "아침 하타 요가", description: null, class_format: "group", place: null, start_time: future(9, 7), end_time: future(9, 8), capacity: 10, status: "open", booking_deadline_min: 60, pass_selection_mode: "all", rooms: null, centers: { name: "하늘 요가 스튜디오", categories: ["요가"], status: "approved" } },
  { id: "cls-4", center_id: "c-near", title: "폐강된 수업", description: "폐강", class_format: "group", place: null, start_time: future(4, 10), end_time: future(4, 11), capacity: 10, status: "cancelled", booking_deadline_min: null, pass_selection_mode: "all", rooms: null, centers: { name: "하늘 요가 스튜디오", categories: ["요가"], status: "approved" } },
  { id: "cls-5", center_id: "c-near", title: "정원 마감 수업", description: null, class_format: "group", place: null, start_time: future(5, 12), end_time: future(5, 13), capacity: 2, status: "open", booking_deadline_min: null, pass_selection_mode: "all", rooms: null, centers: { name: "하늘 요가 스튜디오", categories: ["요가"], status: "approved" } },
  { id: "cls-3", center_id: "c-near", title: "저녁 빈야사", description: null, class_format: "private", place: "2층 스튜디오", start_time: future(3, 19), end_time: future(3, 20), capacity: 1, status: "open", booking_deadline_min: null, pass_selection_mode: "all", rooms: null, centers: { name: "하늘 요가 스튜디오", categories: ["요가"], status: "approved" } },
];

export const FAR_CLASS = { id: "cls-far", center_id: "c-near", title: "먼 달의 수업", description: null, class_format: "group", place: null, start_time: future(FAR_CLASS_DAYS, 10), end_time: future(FAR_CLASS_DAYS, 11), capacity: 10, status: "open", booking_deadline_min: null, pass_selection_mode: "all", rooms: null, centers: { name: "하늘 요가 스튜디오", categories: ["요가"], status: "approved" } };

function tableOf(url: URL): string { return url.pathname.replace(/^\/rest\/v1\//, "").split("/")[0]; }
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

export type MockOpts = { farClass?: boolean; checkoutProduct?: boolean; twoProfiles?: boolean; usableNone?: boolean; usableOnlyP2?: boolean; exhaustedPass?: boolean; emptyCenterPass?: boolean; payments?: { membership_id: string; sale_type: string; total_amount: number }[]; emptyAllowed?: boolean; allowedFail?: boolean; longAddress?: boolean; manyCenters?: boolean; withNextReservation?: boolean; loggedIn?: boolean; hasPass?: boolean; failCenters?: boolean; noReviews?: boolean; reviewsFail?: boolean };
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
      // 운영 권한 재현: class_trainer_names(uuid[]) 는 anon 에 EXECUTE 가 없다(권한 오류). 로그인하면 배정 강사를 돌려준다.
      if (fn === "class_trainer_names") return opts.loggedIn ? json(route, [{ class_id: "cls-1", name: "김하늘", sort_order: 1 }, { class_id: "cls-1", name: "이가람", sort_order: 2 }]) : json(route, { code: "42501", message: "permission denied for function class_trainer_names" }, 403);
      if (fn === "fetch_purchasable_products" || fn === "fetch_public_storefront_products") {
        return json(route, opts.checkoutProduct ? [{ id: "prod-long", center_id: "c-near", center_name: "하늘 요가 스튜디오", name: "[QA] 매우 긴 이름의 프리미엄 스케줄링 수강권 12주 과정 (평일 오전반)", price: 160000, product_kind: "pass", total_count: 2, unlimited: false, description: null, sizes: [], auto_book_days: null, group_label: null, max_quantity: null, coupon_eligible: false, weekday_selectable: false, time_selectable: false, purchase_count_selectable: false }] : []);
      }
      if (fn === "usable_memberships_for_classes") {
        const body = req.postDataJSON() as { p_class_ids?: string[]; p_profile_id?: string } | null;
        const ok = !!opts.loggedIn && !!opts.hasPass && !opts.usableNone && !opts.exhaustedPass && (!opts.usableOnlyP2 || body?.p_profile_id === "p2");
        return json(route, ok ? (body?.p_class_ids ?? []).map((id) => ({ class_id: id, membership_id: "m1", product_name: "하타 10회권", remaining_count: 5, expires_at: "2099-01-01", owner_profile: "회원A", is_mine: true, issued_at: null })) : []);
      }
      return json(route, []);
    }
    const t = tableOf(url);
    const q = url.searchParams;
    const wantsObject = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    const wrap = (rows: Record<string, unknown>[]) => (wantsObject ? (rows[0] ?? null) : rows);
    if (t === "centers") {
      if (opts.failCenters) return json(route, { message: "boom" }, 500);
      const idEq = q.get("id")?.replace("eq.", "");
      // 승인된 센터인데 등록된 수업이 하나도 없는 센터(예약 화면의 센터 맥락 검증용). 그 밖의 알 수 없는 id는 RLS처럼 "읽히지 않음".
      if (idEq === "c-empty-center") return json(route, wrap([{ id: "c-empty-center", name: "수업 준비 중 스튜디오", categories: ["요가"], status: "approved" }]));
      let rows: Record<string, unknown>[] = opts.manyCenters
        ? Array.from({ length: 24 }, (_, i) => ({ ...CENTERS[i % CENTERS.length], id: `c-${i}`, name: `센터 ${String(i).padStart(2, "0")}`, created_at: new Date(Date.now() - i * 1000).toISOString() }))
        : [...CENTERS, ...(opts.longAddress ? [LONG_ADDR_CENTER] : [])];
      if (idEq) rows = rows.filter((c) => c.id === idEq).map((c) => ({ ...c, phone: null, sns: null, intro_blocks: [], pay_methods: null, review_point: 1000, status: "approved" }));
      return json(route, wrap(rows));
    }
    if (t === "center_reviews") { if (opts.reviewsFail) return json(route, { message: "boom" }, 500); return json(route, opts.noReviews ? [] : REVIEWS); }
    if (t === "classes") {
      const idEq = q.get("id")?.replace("eq.", "");
      const centerEq = q.get("center_id")?.replace("eq.", "");
      const ALL = opts.farClass ? [...CLASSES, FAR_CLASS] : CLASSES;
      if (idEq) { const row = ALL.find((c) => c.id === idEq && (!centerEq || c.center_id === centerEq)); return json(route, wrap(row ? [row] : [])); }
      const inCenters = q.get("center_id")?.startsWith("in.(") ? q.get("center_id")!.slice(4, -1).split(",") : null;
      // 월 조회(예약 화면)는 start_time 범위(gte/lt)를 실제로 적용한다 — 다른 달로 이동하는 동안 목록이 그 달 수업만 갖는 실제 동작을 재현.
      const bounds = q.getAll("start_time");
      const gte = bounds.find((b) => b.startsWith("gte."))?.slice(4), lt = bounds.find((b) => b.startsWith("lt."))?.slice(3);
      const inRange = (iso: string) => (!gte || iso >= new Date(gte).toISOString()) && (!lt || iso < new Date(lt).toISOString());
      if (inCenters) return json(route, ALL.filter((c) => inCenters.includes(c.center_id) && inRange(c.start_time)).map((c) => ({ ...c, allow_goods: false, allow_cancel: true, room_id: null, centers: { id: c.center_id, name: c.centers.name, categories: c.centers.categories } })));
      if (q.get("title")?.startsWith("ilike.")) {   // 검색: lib/home.ts searchClasses — 승인 센터의 시작 전 수업(centers!inner)
        const kw = q.get("title")!.slice(6).replaceAll("%", "");
        return json(route, CLASSES.filter((c) => c.title.includes(kw) && new Date(c.start_time).getTime() > Date.now())
          .map((c) => ({ ...c, centers: { name: c.centers.name, status: "approved", latitude: 37.5745, longitude: 126.978 } })));
      }
      const title = q.get("title")?.replace("eq.", "");
      let rows = CLASSES.filter((c) => c.center_id === (q.get("center_id")?.replace("eq.", "") ?? c.center_id) && (q.get("status") ? c.status === q.get("status")!.replace("eq.", "") : true));
      if (title) rows = rows.filter((c) => c.title === title);
      return json(route, rows);
    }
    if (t === "class_reservation_counts") return json(route, CLASSES.map((c) => ({ class_id: c.id, confirmed_count: c.id === "cls-1" ? 4 : c.id === "cls-5" ? 2 : 0 })));
    // 운영 RLS 재현: class_allowed_products SELECT = auth.uid() IS NOT NULL AND class_rows_visible(class_id) → 비로그인은 오류가 아니라 "빈 배열"
    if (t === "class_allowed_products") {
      if (opts.allowedFail) return json(route, { message: "boom" }, 500);
      if (!opts.loggedIn || opts.emptyAllowed) return json(route, []);
      return json(route, [{ class_id: "cls-1", products: { name: "하타 10회권" } }, { class_id: "cls-1", products: { name: "기간제 1개월" } }]);
    }
    if (t === "profiles") return json(route, opts.loggedIn ? [{ id: "p1", name: "회원A", label: null, is_primary: true, account_id: "acc-1" }, ...(opts.twoProfiles ? [{ id: "p2", name: "가족B", label: "자녀", is_primary: false, account_id: "acc-1" }] : [])] : []);
    if (t === "accounts") return json(route, wrap([{ id: "acc-1", name: "회원A", phone: null, is_member: true, is_manager: false, is_platform_admin: false, marketing_consent: false }]));
    if (t === "payments") return json(route, opts.payments ?? []);
    if (t === "memberships") {
      if (!opts.loggedIn) return json(route, []);
      const rows: Record<string, unknown>[] = [];
      const recent = new Date(Date.now() - 2 * 3600_000).toISOString();
      if (opts.hasPass) rows.push({ id: "m1", profile_id: "p1", bound_profile_id: null, center_id: "c-near", product_id: "prod-1", product_name: "하타 5회권", total_count: 5, remaining_count: opts.exhaustedPass ? 0 : 5, expires_at: "2099-01-01", starts_at: "2026-01-01", created_at: recent, status: "active", centers: { name: "하늘 요가 스튜디오" }, products: { product_kind: "pass", unlimited: false } });
      if (opts.emptyCenterPass) rows.push({ id: "m-free", profile_id: "p1", bound_profile_id: null, center_id: "c-empty-center", product_id: "prod-free", product_name: "[QA] UX 검증용 무료 3회권", total_count: 3, remaining_count: 3, expires_at: null, starts_at: "2026-01-01", created_at: recent, status: "active", centers: { name: "수업 준비 중 스튜디오" }, products: { product_kind: "pass", unlimited: false } });
      const centerEq = q.get("center_id")?.replace("eq.", "");
      return json(route, centerEq ? rows.filter((r) => r.center_id === centerEq) : rows);
    }
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
