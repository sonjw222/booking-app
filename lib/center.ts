/*
  센터 상세 화면 데이터
  - 센터 기본 정보 (이름/주소/연락처/소개)
  - 그 센터의 앞으로 예약 가능한 수업 목록
  로그인 없이도 볼 수 있는 공개 조회
*/

import { supabase } from "./supabaseClient";
import { sanitizeRichText } from "./security";
import { getMyAccountId } from "./authAccount";

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
};

export async function fetchCenterProducts(centerId: string): Promise<CenterProduct[]> {
  // MWHABIT Membership Visibility Batch(2026-09-18) — 원래는 이 센터의 is_active+
  // is_on_sale 상품을 전부(공개범위 무관) 가져왔다. fetch_purchasable_products()
  // RPC(SECURITY DEFINER, add_membership_visibility_and_coupons.sql)가 로그인한
  // 회원(my_profile_ids())이 실제로 구매 가능한 상품만 서버에서 걸러서 돌려준다 —
  // "UI에서만 숨기는 방식으로 끝내지 말 것" 원칙에 따라 이 목록 자체가 서버 계산
  // 결과이지, 클라이언트가 전체를 받아서 감추는 게 아니다. 정렬(product_kind asc,
  // price asc)도 RPC 안에서 그대로 유지한다.
  const { data, error } = await supabase
    .rpc("fetch_purchasable_products", { p_center_id: centerId })
    .select("id, name, price, product_kind, total_count, unlimited, description, sizes, auto_book_days, group_label, max_quantity, coupon_eligible");
  if (error) throw new Error("상품을 불러오지 못했어요: " + error.message);
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
  }));
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
