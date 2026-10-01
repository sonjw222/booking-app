/*
  센터 상세 화면 데이터
  - 센터 기본 정보 (이름/주소/연락처/소개)
  - 그 센터의 앞으로 예약 가능한 수업 목록
  로그인 없이도 볼 수 있는 공개 조회
*/

import { supabase } from "./supabaseClient";
import { sanitizeRichText } from "./security";
import { getMyAccountId } from "./authAccount";
import { computeSelectableSchedule, type ScheduleRule, type SelectableSchedule } from "./passes";

export type CenterDetail = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  intro: string | null;
  photoUrl: string | null;
  sns: string | null;
  categories: string[];
  latitude: number | null;
  longitude: number | null;
  introBlocks: IntroBlock[];
  payMethods: string[] | null;
  reviewPoint: number;
};

// 센터 소개 블록 (블로그식: 글/사진 번갈아)
export type IntroTextStyle = "heading" | "body" | "small";
export type IntroAlign = "left" | "center" | "right";
export type IntroBlock =
  | {
      type: "text";
      value: string;              // 기존 저장분(평문). html 이 있으면 html 우선
      html?: string;              // 리치 텍스트 (부분 굵게/색상/기울임 등)
      align?: IntroAlign;         // 정렬
      style?: IntroTextStyle;     // 구버전 호환
      bold?: boolean;             // 구버전 호환
      fontSize?: number;          // 블록 기본 글자 크기
    }
  | { type: "image"; value: string };   // value = storage 경로

export type CenterClass = {
  id: string;
  title: string;
  startText: string;   // "8/3 (월) 19:30"
  reserved: number;
  capacity: number;
};

const KST_DT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric", day: "numeric", weekday: "short",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export async function fetchCenterDetail(centerId: string): Promise<CenterDetail | null> {
  const { data, error } = await supabase
    .from("centers")
    .select("id, name, address, phone, intro, intro_blocks, photo_url, sns, categories, latitude, longitude, pay_methods, review_point, status")
    .eq("id", centerId)
    .eq("status", "approved")
    .maybeSingle();
  if (error) throw new Error("센터 정보를 불러오지 못했어요: " + error.message);
  if (!data) return null;
  return {
    id: data.id, name: data.name,
    address: data.address, phone: data.phone, intro: data.intro,
    photoUrl: data.photo_url, sns: data.sns, categories: data.categories ?? [],
    latitude: data.latitude, longitude: data.longitude,
    introBlocks: Array.isArray(data.intro_blocks) ? data.intro_blocks : [],
    payMethods: data.pay_methods ?? null,
    reviewPoint: data.review_point ?? 1000,
  };
}

export async function fetchCenterClasses(centerId: string): Promise<CenterClass[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("classes")
    .select("id, title, start_time, capacity")
    .eq("center_id", centerId)
    .eq("status", "open")
    .gte("start_time", nowIso)
    .order("start_time", { ascending: true })
    .limit(60);
  if (error) throw new Error("수업을 불러오지 못했어요: " + error.message);

  let rows = data ?? [];

  // 같은 이름의 수업은 가장 빠른 1개만 (센터 소개에서 종류별로 한눈에)
  const seen = new Set<string>();
  rows = rows.filter((r: any) => {
    if (seen.has(r.title)) return false;
    seen.add(r.title);
    return true;
  }).slice(0, 20);

  const ids = rows.map((r: any) => r.id);
  const counts: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: cnt } = await supabase
      .from("class_reservation_counts")
      .select("class_id, confirmed_count")
      .in("class_id", ids);
    for (const c of cnt ?? []) counts[(c as any).class_id] = (c as any).confirmed_count;
  }

  return rows.map((r: any) => ({
    id: r.id,
    title: r.title,
    startText: KST_DT.format(new Date(r.start_time)),
    reserved: counts[r.id] ?? 0,
    capacity: r.capacity,
  }));
}

// 매니저가 센터 소개글 수정
export async function updateCenterIntro(
  centerId: string,
  fields: { intro: string; address: string; phone: string; photoUrl: string | null; sns: string; categories: string[]; latitude: number | null; longitude: number | null; introBlocks: IntroBlock[]; payMethods: string[]; reviewPoint: number }
): Promise<void> {
  const { error } = await supabase
    .from("centers")
    .update({
      intro: fields.intro || null,
      address: fields.address || null,
      phone: fields.phone || null,
      photo_url: fields.photoUrl || null,
      sns: fields.sns || null,
      categories: fields.categories,
      latitude: fields.latitude,
      longitude: fields.longitude,
      intro_blocks: fields.introBlocks.map((b) =>
        b.type === "text" ? { ...b, html: sanitizeRichText(b.html ?? "") } : b
      ),
      pay_methods: fields.payMethods.length > 0 ? fields.payMethods : null,
      review_point: fields.reviewPoint,
    })
    .eq("id", centerId);
  if (error) throw new Error("저장에 실패했어요: " + error.message);
}

// 센터 사진 업로드 (avatars 버킷 재사용)
export async function uploadCenterPhoto(file: File): Promise<string> {
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `center-${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file, { upsert: false });
  if (error) throw new Error("사진 업로드에 실패했어요: " + error.message);
  return path;
}

export function centerPhotoUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return data?.publicUrl ?? null;
}

/* ============================================================
   센터 판매 상품 (회원 구매용) + 구매 신청
   ============================================================ */

export type CenterProduct = {
  id: string;
  name: string;
  price: number;
  kind: "pass" | "goods";
  totalCount: number | null;
  unlimited: boolean;
  validDays: number | null;
  description: string | null;
  sizes: string[] | null;
  autoBookDays: number[] | null;
  groupLabel: string | null;
  remaining: number | null; // 판매 수량 제한이 없으면 null(무제한), 있으면 남은 개수(0=매진)
  couponEligible: boolean;  // false면 결제 화면에서 쿠폰 선택 UI 자체를 숨긴다. add_product_coupon_eligibility.sql
  // 2026-10-01(Batch C) — 구매 시 요일/시간 선택형 수강권. lib/passes.ts의 Product와
  // 같은 의미, 회원용(CenterProduct) 타입에도 그대로 추가.
  weekdaySelectable: boolean;
  timeSelectable: boolean;
};

const CENTER_PRODUCTS_SELECT_BASE = "id, name, price, product_kind, total_count, unlimited, description, sizes, auto_book_days, group_label, max_quantity, coupon_eligible";
const CENTER_PRODUCTS_SELECT_WEEKDAY = `${CENTER_PRODUCTS_SELECT_BASE}, weekday_selectable, time_selectable`;

// 2026-10-01 — 토스페이먼츠 전자결제 심사 대응. 비로그인 사용자는 fetch_purchasable_products()를
// 호출할 권한이 없어(일부러 anon revoke — 회원 등급/지정 회원 전용 상품이 새지 않게) 센터
// 화면 전체가 "찾을 수 없어요"로 떨어졌다. 그래서 두 경로로 나눈다:
//   - 로그인 회원 → 기존 fetchMemberCenterProducts()(회원별 구매 가능 상품, 보안 정책 그대로)
//   - 비로그인    → fetch_public_storefront_products()(승인 센터의 활성·판매중·전체공개 상품만)
// 구매(checkout)는 여전히 로그인이 필요하다 — 여기서 공개되는 건 "조회"뿐이다.
export async function fetchCenterProducts(centerId: string): Promise<CenterProduct[]> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return fetchPublicCenterProducts(centerId);
  try {
    return await fetchMemberCenterProducts(centerId);
  } catch (e: any) {
    // 세션 토큰이 만료돼 요청이 anon으로 처리되면 회원용 RPC는 권한 오류(42501)로 실패한다 —
    // 이때만 공개 목록으로 대체한다(그 외 오류는 그대로 던짐).
    if (e?.code === "42501") return fetchPublicCenterProducts(centerId);
    throw e;
  }
}

export type PublicStorefrontProduct = {
  id: string; centerId: string; centerName: string; name: string; price: number;
  kind: "pass" | "goods"; description: string | null; totalCount: number | null;
  unlimited: boolean; unlimitedPass: boolean; groupLabel: string | null;
  remaining: number | null; // null=수량 제한 없음, 0=매진
};

// 비로그인 포함 누구나 호출 가능한 공개 판매상품(add_public_storefront_products.sql).
// centerId를 생략하면 승인된 모든 센터의 공개 상품(/products 페이지용).
export async function fetchPublicStorefrontProducts(centerId?: string | null): Promise<PublicStorefrontProduct[]> {
  const { data, error } = await supabase.rpc(
    "fetch_public_storefront_products",
    centerId ? { p_center_id: centerId } : {}
  );
  if (error) throw new Error("상품을 불러오지 못했어요: " + error.message);
  return ((data ?? []) as any[]).map((p) => ({
    id: p.id, centerId: p.center_id, centerName: p.center_name, name: p.name, price: p.price,
    kind: p.product_kind === "goods" ? "goods" : "pass",
    description: p.description ?? null, totalCount: p.total_count ?? null,
    unlimited: p.unlimited ?? false, unlimitedPass: p.unlimited_pass ?? false,
    groupLabel: p.group_label ?? null, remaining: p.remaining ?? null,
  }));
}

// 센터별로 묶는다(서버가 센터명 순으로 정렬해서 주므로 등장 순서를 그대로 유지). 상품이 있는
// 센터만 그룹이 생기므로 빈 그룹은 구조적으로 만들어지지 않는다(/products 페이지용).
export function groupPublicProductsByCenter(products: PublicStorefrontProduct[]) {
  const groups: { centerId: string; centerName: string; items: PublicStorefrontProduct[] }[] = [];
  for (const p of products) {
    let g = groups.find((x) => x.centerId === p.centerId);
    if (!g) { g = { centerId: p.centerId, centerName: p.centerName, items: [] }; groups.push(g); }
    g.items.push(p);
  }
  return groups;
}

// 센터 화면이 쓰는 CenterProduct 형태로 변환. 사이즈/자동예약/요일 선택/쿠폰 가능 여부처럼
// 공개 RPC가 일부러 반환하지 않는 항목은 안전한 기본값 — 어차피 구매는 로그인 후
// 회원용 경로(sizes 등 전체 필드)로 진행된다.
async function fetchPublicCenterProducts(centerId: string): Promise<CenterProduct[]> {
  const rows = await fetchPublicStorefrontProducts(centerId);
  return rows.map((p) => ({
    id: p.id, name: p.name, price: p.price, kind: p.kind,
    totalCount: p.totalCount, unlimited: p.unlimited,
    validDays: null, description: p.description, sizes: null, autoBookDays: null,
    groupLabel: p.groupLabel, remaining: p.remaining, couponEligible: true,
    weekdaySelectable: false, timeSelectable: false,
  }));
}

async function fetchMemberCenterProducts(centerId: string): Promise<CenterProduct[]> {
  // MWHABIT Membership Visibility Batch(2026-09-18) — 원래는 이 센터의 is_active+
  // is_on_sale 상품을 전부(공개범위 무관) 가져왔다. fetch_purchasable_products()
  // RPC(SECURITY DEFINER, add_membership_visibility_and_coupons.sql)가 로그인한
  // 회원(my_profile_ids())이 실제로 구매 가능한 상품만 서버에서 걸러서 돌려준다 —
  // "UI에서만 숨기는 방식으로 끝내지 말 것" 원칙에 따라 이 목록 자체가 서버 계산
  // 결과이지, 클라이언트가 전체를 받아서 감추는 게 아니다. 정렬(product_kind asc,
  // price asc)도 RPC 안에서 그대로 유지한다.
  // fetch_purchasable_products()는 "select p.* from products p ..."라 add_weekday_
  // time_fixed_memberships.sql이 만드는 두 새 컬럼도 RPC 자체는 자동으로 포함한다 —
  // 이 select() 프로젝션 문자열만 바뀌면 된다. 컬럼이 아직 없는 환경(42703)에서도
  // 구매 화면 전체가 깨지지 않도록 방어(lib/rooms.ts, lib/passes.ts와 동일 패턴).
  const first = await supabase
    .rpc("fetch_purchasable_products", { p_center_id: centerId })
    .select(CENTER_PRODUCTS_SELECT_WEEKDAY);
  let data: any[] | null = first.data as any;
  let error = first.error;
  if (error?.code === "42703") {
    const fallback = await supabase
      .rpc("fetch_purchasable_products", { p_center_id: centerId })
      .select(CENTER_PRODUCTS_SELECT_BASE);
    data = fallback.data as any;
    error = fallback.error;
  }
  if (error) throw Object.assign(new Error("상품을 불러오지 못했어요: " + error.message), { code: error.code });
  // Postgres 함수가 setof products를 반환하는 RPC라 supabase-js의 기본 타입 추론이
  // "단일 행 | 배열" 유니온으로 잡는다(.single() 없이도) — 실제로는 여러 행이 올 수
  // 있으므로 배열로 명시한다.
  const rows = (data ?? []) as any[];

  const limitedIds = rows.filter((p: any) => p.max_quantity != null).map((p: any) => p.id);
  let soldByProduct: Record<string, number> = {};
  if (limitedIds.length > 0) {
    const { data: counts, error: countErr } = await supabase
      .from("product_sale_counts")
      .select("product_id, sold_count")
      .in("product_id", limitedIds);
    if (countErr) throw new Error("판매 개수를 불러오지 못했어요: " + countErr.message);
    for (const c of counts ?? []) soldByProduct[(c as any).product_id] = (c as any).sold_count;
  }

  return rows.map((p: any) => ({
    id: p.id, name: p.name, price: p.price,
    kind: p.product_kind === "goods" ? "goods" : "pass",
    totalCount: p.total_count, unlimited: p.unlimited ?? false,
    validDays: null,
    description: p.description ?? null,
    sizes: p.sizes ?? null,
    autoBookDays: p.auto_book_days ?? null,
    groupLabel: p.group_label ?? null,
    remaining: p.max_quantity != null ? Math.max(0, p.max_quantity - (soldByProduct[p.id] ?? 0)) : null,
    couponEligible: p.coupon_eligible ?? true,
    weekdaySelectable: p.weekday_selectable ?? false,
    timeSelectable: p.time_selectable ?? false,
  }));
}

// 2026-10-01(Batch C, C-5) — weekdaySelectable 상품의 구매 시 요일/시간 선택 후보.
// lib/passes.ts의 매니저용 fetchRules/computeSelectableSchedule과 같은 테이블
// (membership_schedule_rules)을 재사용한다 — 새 스케줄 데이터를 만들지 않음. RLS
// "예약조건 조회"가 로그인한 사용자 전체에게 select를 허용해서(관리자 권한 불필요)
// 회원 화면에서도 매니저 전용 함수를 거치지 않고 바로 조회할 수 있다.
export async function fetchPurchaseScheduleOptions(productId: string): Promise<SelectableSchedule> {
  const { data, error } = await supabase
    .from("membership_schedule_rules")
    .select("day_of_week, start_time")
    .eq("product_id", productId);
  if (error) throw new Error("선택 가능한 요일/시간을 불러오지 못했어요: " + error.message);
  const rules: ScheduleRule[] = (data ?? []).map((r: any) => ({
    id: "", dayOfWeek: r.day_of_week, startTime: r.start_time ? String(r.start_time).slice(0, 5) : null, classTitle: null,
  }));
  return computeSelectableSchedule(rules);
}

// 회원이 특정 센터에 유효한 수강권을 갖고 있는지 (예약 가능 여부 판단)
export async function hasActivePassAtCenter(centerId: string): Promise<boolean> {
  const accountId = await getMyAccountId();
  if (!accountId) return false;
  const { data: profs } = await supabase.from("profiles").select("id").eq("account_id", accountId).is("deleted_at", null);
  const ids = (profs ?? []).map((p: any) => p.id);
  if (ids.length === 0) return false;

  const { data } = await supabase
    .from("memberships")
    .select("id, remaining_count, expires_at, status, products(product_kind)")
    .in("profile_id", ids)
    .eq("center_id", centerId)
    .eq("status", "active");
  const today = new Date().toISOString().slice(0, 10);
  return (data ?? []).some((m: any) =>
    m.products?.product_kind !== "goods" &&
    (m.remaining_count == null || m.remaining_count > 0) &&
    (!m.expires_at || m.expires_at >= today)
  );
}

// 구매 신청 (온라인 결제 전이므로, 매니저가 확인할 신청으로 기록)
export async function requestPurchase(centerId: string, productId: string, productName: string): Promise<void> {
  const accountId = await getMyAccountId();
  if (!accountId) throw new Error("로그인이 필요해요");
  const { data: profs } = await supabase
    .from("profiles").select("id, is_primary, created_at")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  const prof = profs?.[0];
  if (!prof) throw new Error("프로필을 찾을 수 없어요. 프로필 관리에서 프로필을 만들어주세요.");

  const { error } = await supabase.from("purchase_requests").insert({
    center_id: centerId, profile_id: prof.id, product_id: productId, product_name: productName,
  });
  if (error) throw new Error("구매 신청에 실패했어요: " + error.message);
}

/* ============================================================
   수업별 이용 가능 수강권 (센터 상세에서 표시)
   - 특정 수업을 어떤 수강권으로 들을 수 있는지
   - class_allowed_products 로 지정된 게 있으면 그 수강권들,
     없으면 "모든 수강권" 으로 간주
   ============================================================ */

export async function fetchClassAllowedPasses(centerId: string): Promise<Record<string, string[]>> {
  // 이 센터 수업들의 title → 허용 수강권 이름 목록
  const { data: classes } = await supabase
    .from("classes").select("id, title").eq("center_id", centerId);
  const classIds = (classes ?? []).map((c: any) => c.id);
  const titleById: Record<string, string> = {};
  for (const c of classes ?? []) titleById[(c as any).id] = (c as any).title;
  if (classIds.length === 0) return {};

  const { data: links } = await supabase
    .from("class_allowed_products")
    .select("class_id, products(name)")
    .in("class_id", classIds);

  // title → set(수강권명)
  const byTitle: Record<string, Set<string>> = {};
  for (const l of links ?? []) {
    const title = titleById[(l as any).class_id];
    const pname = (l as any).products?.name;
    if (!title || !pname) continue;
    (byTitle[title] ??= new Set()).add(pname);
  }
  const out: Record<string, string[]> = {};
  for (const t of Object.keys(byTitle)) out[t] = Array.from(byTitle[t]);
  return out;
}
