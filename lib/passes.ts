/*
  매니저 - 수강권 상품 & 예약조건
  - 상품(products) 목록/생성/삭제
  - 상품별 예약조건(membership_schedule_rules) 추가/삭제
  - 조건이 없으면 = 모든 수업 예약 가능
  - 조건이 있으면 = 하나라도 매칭되는 수업만 예약 가능
*/

import { supabase } from "./supabaseClient";

export const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

export type ExpiryMode = "none" | "days" | "date" | "rolling_month";

// MWHABIT Membership Visibility Batch(2026-09-18) — 수강권 공개범위.
// all(전체 회원)/grades(특정 등급)/selected_members(지정 회원만). memberIds는
// profile_id가 아니라 center_members.id(=center_member_id) — 다른 센터 회원과 구조적으로
// 섞이지 않게 add_membership_visibility_and_coupons.sql의 매핑 테이블과 동일한 기준을 쓴다.
export type ProductVisibility = {
  type: "all" | "grades" | "selected_members";
  gradeIds: string[];
  memberIds: string[]; // center_member_id
};

export type Product = {
  id: string;
  name: string;
  price: number;
  passType: "count" | "period";
  totalCount: number | null;
  isOnSale: boolean;
  kind: "pass" | "goods";
  unlimited: boolean;
  unlimitedPass: boolean;          // 수강권(pass) 횟수 무제한 — goods의 unlimited와 별개(add_product_expiry_options.sql)
  expiryMode: ExpiryMode;          // none=만료 없음, days=구매일+expiryDays, date=expiryDate 고정(시즌권), rolling_month=매달 자동(add_rolling_month_product_expiry.sql)
  expiryDays: number | null;
  expiryDate: string | null;       // "YYYY-MM-DD"
  rollingMonthCutoffDay: number | null;      // rolling_month일 때: 1~31, 이 날짜부터 다음 달로 넘어감
  rollingMonthAllowEarlyUse: boolean;        // true면 다음 달로 넘어가도 즉시 사용 허용(starts_at 안 걸림)
  description: string | null;
  sizes: string[] | null;
  autoBookDays: number[] | null;   // 요일반 수강권: 자동예약 요일 (0=일~6=토)
  groupLabel: string | null;       // 수강권 표시용 대분류(자유 텍스트, add_product_group_label.sql)
  maxQuantity: number | null;      // 판매 수량 제한(null=무제한). add_product_sale_limit.sql
  soldCount: number;                // 지금까지 발급된(환불 제외) 개수 — maxQuantity와 비교해 "N개 남음" 표시
  visibility: ProductVisibility;
  couponEligible: boolean;          // false면 이 상품엔 어떤 쿠폰도 적용 불가(쿠폰 쪽 applies_to보다 우선). add_product_coupon_eligibility.sql
};

export type ScheduleRule = {
  id: string;
  dayOfWeek: number | null;   // null = 모든 요일
  startTime: string | null;   // "19:00", null = 모든 시간
  classTitle: string | null;  // null = 모든 수업
};

// 센터 상품 목록
export async function fetchProducts(centerId: string, kind: "pass" | "goods" = "pass"): Promise<Product[]> {
  const { data, error } = await supabase
    .from("products")
    .select("id, name, price, pass_type, total_count, is_on_sale, product_kind, unlimited, unlimited_pass, expiry_mode, expiry_days, expiry_date, rolling_month_cutoff_day, rolling_month_allow_early_use, description, sizes, auto_book_days, group_label, max_quantity, visibility_type, coupon_eligible")
    .eq("center_id", centerId)
    .eq("is_active", true)
    .eq("product_kind", kind)
    .order("created_at", { ascending: false });
  if (error) throw new Error("상품을 불러오지 못했어요: " + error.message);
  const rows = data ?? [];
  const ids = rows.map((p: any) => p.id);

  // 판매 수량 제한이 걸린 상품만 판매 개수를 조회 (add_product_sale_limit.sql의 뷰,
  // 개인정보 없는 집계라 별도 권한 체크 불필요 — class_reservation_counts와 동일 패턴)
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

  // MWHABIT Membership Visibility Batch(2026-09-18) — 공개범위 매핑을 상품마다 따로
  // 쿼리하지 않고(N+1 방지, 요청 23번) 이 목록에 포함된 상품 id 전체로 한 번씩만
  // 조회해 그룹핑한다.
  const gradesByProduct: Record<string, string[]> = {};
  const membersByProduct: Record<string, string[]> = {};
  if (ids.length > 0) {
    const [{ data: gradeRows, error: gradeErr }, { data: memberRows, error: memberErr }] = await Promise.all([
      supabase.from("membership_product_grades").select("product_id, grade_id").in("product_id", ids),
      supabase.from("membership_product_members").select("product_id, center_member_id").in("product_id", ids),
    ]);
    if (gradeErr) throw new Error("공개범위(등급)를 불러오지 못했어요: " + gradeErr.message);
    if (memberErr) throw new Error("공개범위(지정회원)를 불러오지 못했어요: " + memberErr.message);
    for (const g of gradeRows ?? []) (gradesByProduct[(g as any).product_id] ??= []).push((g as any).grade_id);
    for (const m of memberRows ?? []) (membersByProduct[(m as any).product_id] ??= []).push((m as any).center_member_id);
  }

  return rows.map((p: any) => ({
    id: p.id, name: p.name, price: p.price,
    passType: p.pass_type, totalCount: p.total_count, isOnSale: p.is_on_sale,
    kind: p.product_kind, unlimited: p.unlimited,
    unlimitedPass: p.unlimited_pass, expiryMode: p.expiry_mode, expiryDays: p.expiry_days, expiryDate: p.expiry_date,
    rollingMonthCutoffDay: p.rolling_month_cutoff_day ?? null, rollingMonthAllowEarlyUse: p.rolling_month_allow_early_use ?? false,
    description: p.description ?? null, sizes: p.sizes ?? null,
    autoBookDays: p.auto_book_days ?? null,
    groupLabel: p.group_label ?? null,
    maxQuantity: p.max_quantity ?? null,
    soldCount: soldByProduct[p.id] ?? 0,
    visibility: {
      type: p.visibility_type ?? "all",
      gradeIds: gradesByProduct[p.id] ?? [],
      memberIds: membersByProduct[p.id] ?? [],
    },
    couponEligible: p.coupon_eligible ?? true,
  }));
}

export type ExpiryOption = {
  mode: ExpiryMode; days: number | null; date: string | null;
  cutoffDay: number | null; allowEarlyUse: boolean;
};

// MWHABIT Membership Visibility Batch(2026-09-18) — 공개범위 저장. products.visibility_type
// 값 자체는 각 create/updateProduct의 insert/update payload에서 같이 넣고, 이 함수는
// 매핑 테이블(membership_product_grades/members)만 "전부 지우고 새로 채우기"로 갱신한다 —
// 상품 하나당 대상이 몇 개 안 되는 규모라 delete-then-insert가 diff 계산보다 단순하고
// 충분히 빠르다(요청 7번 "변경 시 사용하지 않는 mapping은 적절히 정리"). RLS
// (membership_product_grades/members의 "매니저 ... 관리" 정책)가 다른 센터의 등급/회원을
// 매핑하려는 insert 자체를 이미 서버에서 거부하므로, 여기서는 그 결과를 그대로 던진다.
async function saveProductVisibility(productId: string, visibility?: ProductVisibility): Promise<void> {
  if (!visibility) return; // 호출부가 공개범위를 안 건드리면(예: 다른 필드만 바꾸는 내부 호출) 그대로 둠
  await supabase.from("membership_product_grades").delete().eq("product_id", productId);
  await supabase.from("membership_product_members").delete().eq("product_id", productId);

  if (visibility.type === "grades" && visibility.gradeIds.length > 0) {
    const { error } = await supabase
      .from("membership_product_grades")
      .insert(visibility.gradeIds.map((gradeId) => ({ product_id: productId, grade_id: gradeId })));
    if (error) throw new Error("공개범위(등급) 저장에 실패했어요: " + error.message);
  }
  if (visibility.type === "selected_members" && visibility.memberIds.length > 0) {
    const { error } = await supabase
      .from("membership_product_members")
      .insert(visibility.memberIds.map((centerMemberId) => ({ product_id: productId, center_member_id: centerMemberId })));
    if (error) throw new Error("공개범위(지정회원) 저장에 실패했어요: " + error.message);
  }
}

export async function createProduct(
  centerId: string, name: string, price: number, totalCount: number,
  kind: "pass" | "goods" = "pass", unlimited = false,
  extra?: { description?: string; sizes?: string[]; autoBookDays?: number[]; unlimitedPass?: boolean; expiry?: ExpiryOption; groupLabel?: string; maxQuantity?: number | null; visibility?: ProductVisibility; couponEligible?: boolean }
): Promise<void> {
  const { data, error } = await supabase.from("products").insert({
    center_id: centerId, name, price,
    product_kind: kind,
    unlimited,
    unlimited_pass: extra?.unlimitedPass ?? false,
    pass_type: "count",
    total_count: unlimited || extra?.unlimitedPass ? null : totalCount,
    expiry_mode: extra?.expiry?.mode ?? "none",
    expiry_days: extra?.expiry?.mode === "days" ? extra.expiry.days : null,
    expiry_date: extra?.expiry?.mode === "date" ? extra.expiry.date : null,
    rolling_month_cutoff_day: extra?.expiry?.mode === "rolling_month" ? extra.expiry.cutoffDay : null,
    rolling_month_allow_early_use: extra?.expiry?.mode === "rolling_month" ? (extra.expiry.allowEarlyUse ?? false) : false,
    description: extra?.description || null,
    sizes: extra?.sizes && extra.sizes.length > 0 ? extra.sizes : null,
    auto_book_days: extra?.autoBookDays && extra.autoBookDays.length > 0 ? extra.autoBookDays : null,
    group_label: extra?.groupLabel?.trim() || null,
    max_quantity: extra?.maxQuantity ?? null,
    visibility_type: extra?.visibility?.type ?? "all",
    coupon_eligible: extra?.couponEligible ?? true,
  }).select("id").single();
  if (error || !data) throw new Error("상품 생성에 실패했어요: " + (error?.message ?? "no data"));
  await saveProductVisibility((data as any).id, extra?.visibility);
}

// 상품 수정 (이름·가격·횟수·설명·사이즈)
export async function updateProduct(
  id: string, name: string, price: number, totalCount: number,
  unlimited: boolean, extra?: { description?: string; sizes?: string[]; autoBookDays?: number[]; unlimitedPass?: boolean; expiry?: ExpiryOption; groupLabel?: string; maxQuantity?: number | null; visibility?: ProductVisibility; couponEligible?: boolean }
): Promise<void> {
  const { error } = await supabase.from("products").update({
    name, price,
    unlimited,
    unlimited_pass: extra?.unlimitedPass ?? false,
    total_count: unlimited || extra?.unlimitedPass ? null : totalCount,
    expiry_mode: extra?.expiry?.mode ?? "none",
    expiry_days: extra?.expiry?.mode === "days" ? extra.expiry.days : null,
    expiry_date: extra?.expiry?.mode === "date" ? extra.expiry.date : null,
    rolling_month_cutoff_day: extra?.expiry?.mode === "rolling_month" ? extra.expiry.cutoffDay : null,
    rolling_month_allow_early_use: extra?.expiry?.mode === "rolling_month" ? (extra.expiry.allowEarlyUse ?? false) : false,
    description: extra?.description || null,
    sizes: extra?.sizes && extra.sizes.length > 0 ? extra.sizes : null,
    auto_book_days: extra?.autoBookDays && extra.autoBookDays.length > 0 ? extra.autoBookDays : null,
    group_label: extra?.groupLabel?.trim() || null,
    ...(extra?.visibility ? { visibility_type: extra.visibility.type } : {}),
    max_quantity: extra?.maxQuantity ?? null,
    // extra.couponEligible을 안 넘긴 호출(예: 아직 이 옵션 UI가 없는 화면)은 기존 값을
    // 건드리지 않는다 — visibility와 동일한 패턴, 매번 true로 되돌리면 안 됨.
    ...(extra?.couponEligible !== undefined ? { coupon_eligible: extra.couponEligible } : {}),
  }).eq("id", id);
  if (error) throw new Error("상품 수정에 실패했어요: " + error.message);
  await saveProductVisibility(id, extra?.visibility);
}

export async function deleteProduct(id: string): Promise<void> {
  // 소프트 삭제 (판매/발급 이력 보존)
  const { error } = await supabase.from("products").update({ is_active: false }).eq("id", id);
  if (error) throw new Error("상품 삭제에 실패했어요: " + error.message);
}

// 판매정지/재개 — deleteProduct(영구 비활성화)와 달리 일시적으로 신규 판매만 막고
// 언제든 재개할 수 있다. 기존 보유자의 예약/사용에는 영향 없음.
export async function toggleProductSale(id: string, onSale: boolean): Promise<void> {
  const { error } = await supabase.rpc("toggle_product_sale_safe", { p_product_id: id, p_on_sale: onSale });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

// 상품의 예약조건 목록
export async function fetchRules(productId: string): Promise<ScheduleRule[]> {
  const { data, error } = await supabase
    .from("membership_schedule_rules")
    .select("id, day_of_week, start_time, class_title")
    .eq("product_id", productId)
    .order("created_at");
  if (error) throw new Error("예약조건을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    dayOfWeek: r.day_of_week,
    startTime: r.start_time ? String(r.start_time).slice(0, 5) : null,
    classTitle: r.class_title,
  }));
}

export async function addRule(
  productId: string,
  dayOfWeek: number | null,
  startTime: string | null,
  classTitle: string | null
): Promise<void> {
  const { error } = await supabase.from("membership_schedule_rules").insert({
    product_id: productId,
    day_of_week: dayOfWeek,
    start_time: startTime,
    class_title: classTitle || null,
  });
  if (error) throw new Error("조건 추가에 실패했어요: " + error.message);
}

export async function deleteRule(id: string): Promise<void> {
  // 삭제 전, 이 조건의 상품/수업명 확보 (수업↔수강권 연결도 함께 정리)
  const { data: rule } = await supabase
    .from("membership_schedule_rules")
    .select("product_id, class_title")
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase.from("membership_schedule_rules").delete().eq("id", id);
  if (error) throw new Error("조건 삭제에 실패했어요: " + error.message);

  // 양방향: 이 수업명으로 지정된 class_allowed_products에서 이 상품 연결 제거
  //   → 수업 수정 화면의 "예약 가능 수강권"에서도 빠짐
  if (rule?.product_id && rule?.class_title) {
    const { data: classes } = await supabase
      .from("classes").select("id").eq("title", rule.class_title);
    const classIds = (classes ?? []).map((c: any) => c.id);
    if (classIds.length > 0) {
      await supabase.from("class_allowed_products")
        .delete()
        .eq("product_id", rule.product_id)
        .in("class_id", classIds);
    }
  }
}

// 조건을 사람이 읽는 문장으로
export function ruleToText(r: ScheduleRule): string {
  const parts: string[] = [];
  parts.push(r.dayOfWeek === null ? "모든 요일" : `${DAYS[r.dayOfWeek]}요일`);
  parts.push(r.startTime === null ? "모든 시간" : r.startTime);
  parts.push(r.classTitle === null ? "모든 수업" : r.classTitle);
  return parts.join(" · ");
}

// 여러 상품의 예약조건을 한 번에 조회 (N+1 방지) — 수업 등록/수정 화면에서
// "이 수업에서 실제로 못 쓰는 수강권" 경고를 계산할 때 사용.
export async function fetchRulesForProducts(productIds: string[]): Promise<Record<string, ScheduleRule[]>> {
  if (productIds.length === 0) return {};
  const { data, error } = await supabase
    .from("membership_schedule_rules")
    .select("id, product_id, day_of_week, start_time, class_title")
    .in("product_id", productIds)
    .order("created_at");
  if (error) throw new Error("예약조건을 불러오지 못했어요: " + error.message);
  const out: Record<string, ScheduleRule[]> = {};
  for (const r of (data ?? []) as any[]) {
    (out[r.product_id] ??= []).push({
      id: r.id,
      dayOfWeek: r.day_of_week,
      startTime: r.start_time ? String(r.start_time).slice(0, 5) : null,
      classTitle: r.class_title,
    });
  }
  return out;
}

// usable_memberships_for_classes()/usable_memberships()의 membership_schedule_rules
// 판정 조건과 정확히 동일한 로직(fix_usable_memberships_product_kind.sql 참고) —
// 규칙이 하나도 없으면 항상 허용, 있으면 dayOfWeek/startTime/classTitle이 전부(null이 아닌
// 항목만) 일치하는 규칙이 하나라도 있어야 허용.
export function matchesAnyScheduleRule(
  rules: ScheduleRule[],
  target: { dayOfWeek: number; startTime: string; classTitle: string }
): boolean {
  if (rules.length === 0) return true;
  return rules.some(
    (r) =>
      (r.dayOfWeek === null || r.dayOfWeek === target.dayOfWeek) &&
      (r.startTime === null || r.startTime === target.startTime) &&
      (r.classTitle === null || r.classTitle === target.classTitle)
  );
}

// 수업 등록/수정 화면에서 "예약 가능 수강권"으로 candidateProducts가 주어졌을 때,
// 그중 실제로는(membership_schedule_rules 때문에) 이 수업에서 못 쓰는 상품 목록을 계산.
// class_allowed_products("모든 수강권 허용"/특정 지정) 제한과는 완전히 별개의 조건이라,
// 관리자가 "모든 수강권 허용"을 골라도 이 목록에 뜨는 상품은 실제로는 예약에 쓸 수 없다.
export type ScheduleExcludedProduct = { productId: string; productName: string; rules: ScheduleRule[] };
export function findScheduleExcludedProducts(
  candidateProducts: { id: string; name: string }[],
  rulesByProduct: Record<string, ScheduleRule[]>,
  target: { dayOfWeek: number; startTime: string; classTitle: string }
): ScheduleExcludedProduct[] {
  const out: ScheduleExcludedProduct[] = [];
  for (const p of candidateProducts) {
    const rules = rulesByProduct[p.id] ?? [];
    if (rules.length === 0) continue;
    if (!matchesAnyScheduleRule(rules, target)) {
      out.push({ productId: p.id, productName: p.name, rules });
    }
  }
  return out;
}

export function won(n: number): string {
  return n.toLocaleString("ko-KR") + "원";
}
