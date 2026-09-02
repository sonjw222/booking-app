/*
  매니저 - 수강권 상품 & 예약조건
  - 상품(products) 목록/생성/삭제
  - 상품별 예약조건(membership_schedule_rules) 추가/삭제
  - 조건이 없으면 = 모든 수업 예약 가능
  - 조건이 있으면 = 하나라도 매칭되는 수업만 예약 가능
*/

import { supabase } from "./supabaseClient";

export const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

export type ExpiryMode = "none" | "days" | "date";

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
  expiryMode: ExpiryMode;          // none=만료 없음, days=구매일+expiryDays, date=expiryDate 고정(시즌권)
  expiryDays: number | null;
  expiryDate: string | null;       // "YYYY-MM-DD"
  description: string | null;
  sizes: string[] | null;
  autoBookDays: number[] | null;   // 요일반 수강권: 자동예약 요일 (0=일~6=토)
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
    .select("id, name, price, pass_type, total_count, is_on_sale, product_kind, unlimited, unlimited_pass, expiry_mode, expiry_days, expiry_date, description, sizes, auto_book_days")
    .eq("center_id", centerId)
    .eq("is_active", true)
    .eq("product_kind", kind)
    .order("created_at", { ascending: false });
  if (error) throw new Error("상품을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((p: any) => ({
    id: p.id, name: p.name, price: p.price,
    passType: p.pass_type, totalCount: p.total_count, isOnSale: p.is_on_sale,
    kind: p.product_kind, unlimited: p.unlimited,
    unlimitedPass: p.unlimited_pass, expiryMode: p.expiry_mode, expiryDays: p.expiry_days, expiryDate: p.expiry_date,
    description: p.description ?? null, sizes: p.sizes ?? null,
    autoBookDays: p.auto_book_days ?? null,
  }));
}

export type ExpiryOption = { mode: ExpiryMode; days: number | null; date: string | null };

export async function createProduct(
  centerId: string, name: string, price: number, totalCount: number,
  kind: "pass" | "goods" = "pass", unlimited = false,
  extra?: { description?: string; sizes?: string[]; autoBookDays?: number[]; unlimitedPass?: boolean; expiry?: ExpiryOption }
): Promise<void> {
  const { error } = await supabase.from("products").insert({
    center_id: centerId, name, price,
    product_kind: kind,
    unlimited,
    unlimited_pass: extra?.unlimitedPass ?? false,
    pass_type: "count",
    total_count: unlimited || extra?.unlimitedPass ? null : totalCount,
    expiry_mode: extra?.expiry?.mode ?? "none",
    expiry_days: extra?.expiry?.mode === "days" ? extra.expiry.days : null,
    expiry_date: extra?.expiry?.mode === "date" ? extra.expiry.date : null,
    description: extra?.description || null,
    sizes: extra?.sizes && extra.sizes.length > 0 ? extra.sizes : null,
    auto_book_days: extra?.autoBookDays && extra.autoBookDays.length > 0 ? extra.autoBookDays : null,
  });
  if (error) throw new Error("상품 생성에 실패했어요: " + error.message);
}

// 상품 수정 (이름·가격·횟수·설명·사이즈)
export async function updateProduct(
  id: string, name: string, price: number, totalCount: number,
  unlimited: boolean, extra?: { description?: string; sizes?: string[]; autoBookDays?: number[]; unlimitedPass?: boolean; expiry?: ExpiryOption }
): Promise<void> {
  const { error } = await supabase.from("products").update({
    name, price,
    unlimited,
    unlimited_pass: extra?.unlimitedPass ?? false,
    total_count: unlimited || extra?.unlimitedPass ? null : totalCount,
    expiry_mode: extra?.expiry?.mode ?? "none",
    expiry_days: extra?.expiry?.mode === "days" ? extra.expiry.days : null,
    expiry_date: extra?.expiry?.mode === "date" ? extra.expiry.date : null,
    description: extra?.description || null,
    sizes: extra?.sizes && extra.sizes.length > 0 ? extra.sizes : null,
    auto_book_days: extra?.autoBookDays && extra.autoBookDays.length > 0 ? extra.autoBookDays : null,
  }).eq("id", id);
  if (error) throw new Error("상품 수정에 실패했어요: " + error.message);
}

export async function deleteProduct(id: string): Promise<void> {
  // 소프트 삭제 (판매/발급 이력 보존)
  const { error } = await supabase.from("products").update({ is_active: false }).eq("id", id);
  if (error) throw new Error("상품 삭제에 실패했어요: " + error.message);
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
