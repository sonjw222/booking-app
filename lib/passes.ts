/*
  매니저 - 수강권 상품 & 예약조건
  - 상품(products) 목록/생성/삭제
  - 상품별 예약조건(membership_schedule_rules) 추가/삭제
  - 조건이 없으면 = 모든 수업 예약 가능
  - 조건이 있으면 = 하나라도 매칭되는 수업만 예약 가능
*/

import { supabase } from "./supabaseClient";

export const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

export type Product = {
  id: string;
  name: string;
  price: number;
  passType: "count" | "period";
  totalCount: number | null;
  isOnSale: boolean;
  kind: "pass" | "goods";
  unlimited: boolean;
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
    .select("id, name, price, pass_type, total_count, is_on_sale, product_kind, unlimited, description, sizes, auto_book_days")
    .eq("center_id", centerId)
    .eq("is_active", true)
    .eq("product_kind", kind)
    .order("created_at", { ascending: false });
  if (error) throw new Error("상품을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((p: any) => ({
    id: p.id, name: p.name, price: p.price,
    passType: p.pass_type, totalCount: p.total_count, isOnSale: p.is_on_sale,
    kind: p.product_kind, unlimited: p.unlimited,
    description: p.description ?? null, sizes: p.sizes ?? null,
    autoBookDays: p.auto_book_days ?? null,
  }));
}

export async function createProduct(
  centerId: string, name: string, price: number, totalCount: number,
  kind: "pass" | "goods" = "pass", unlimited = false,
  extra?: { description?: string; sizes?: string[]; autoBookDays?: number[] }
): Promise<void> {
  const { error } = await supabase.from("products").insert({
    center_id: centerId, name, price,
    product_kind: kind,
    unlimited,
    pass_type: "count",
    total_count: unlimited ? null : totalCount,
    description: extra?.description || null,
    sizes: extra?.sizes && extra.sizes.length > 0 ? extra.sizes : null,
    auto_book_days: extra?.autoBookDays && extra.autoBookDays.length > 0 ? extra.autoBookDays : null,
  });
  if (error) throw new Error("상품 생성에 실패했어요: " + error.message);
}

// 상품 수정 (이름·가격·횟수·설명·사이즈)
export async function updateProduct(
  id: string, name: string, price: number, totalCount: number,
  unlimited: boolean, extra?: { description?: string; sizes?: string[]; autoBookDays?: number[] }
): Promise<void> {
  const { error } = await supabase.from("products").update({
    name, price,
    unlimited,
    total_count: unlimited ? null : totalCount,
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

export function won(n: number): string {
  return n.toLocaleString("ko-KR") + "원";
}
