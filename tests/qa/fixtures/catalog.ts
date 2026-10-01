/*
  시나리오용 임시 데이터(수업/수강권/대여상품) 생성 — 전부 "[QA <runId>]" 이름이고 tracker에 UUID가 기록돼 그 목록으로만 정리된다.
  admin(service_role)으로 만들지만 테스트 대상 동작(예약/취소)은 호출하지 않는다.
*/
import type { SupabaseClient } from "@supabase/supabase-js";
import { FixtureTracker, qaName } from "../runContext";

const dateStr = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

export async function createQaClass(
  admin: SupabaseClient, t: FixtureTracker, centerId: string, opts?: { hoursFromNow?: number; capacity?: number }
): Promise<string> {
  const start = new Date(Date.now() + (opts?.hoursFromNow ?? 72) * 3600_000);
  const end = new Date(start.getTime() + 3600_000);
  const { data, error } = await admin.from("classes").insert({
    center_id: centerId, title: qaName(t.runId, "수업"), start_time: start.toISOString(), end_time: end.toISOString(),
    capacity: opts?.capacity ?? 8, class_format: "group", allow_goods: true, status: "open",
  }).select("id").single();
  if (error || !data) throw new Error(`QA 수업 생성 실패: ${error?.message}`);
  t.add("classes", data.id);
  return data.id as string;
}

// 상품(product) 없이 만드는 일반 수강권 — pass_selection_mode='all' 수업에서 사용 가능(product_id null).
export async function createQaPassMembership(
  admin: SupabaseClient, t: FixtureTracker, centerId: string, profileId: string, remaining = 5
): Promise<string> {
  const { data, error } = await admin.from("memberships").insert({
    profile_id: profileId, center_id: centerId, product_name: qaName(t.runId, "수강권"), pass_type: "count",
    total_count: remaining, remaining_count: remaining, starts_at: dateStr(0), expires_at: dateStr(60), status: "active",
  }).select("id").single();
  if (error || !data) throw new Error(`QA 수강권 생성 실패: ${error?.message}`);
  t.add("memberships", data.id);
  return data.id as string;
}

// 대여상품(goods) 정의(공개 안 됨: is_on_sale=false) + QA 회원에게 지급된 membership(시작 remaining=count, 사이즈 선택값 저장).
export async function createQaGoodsMembership(
  admin: SupabaseClient, t: FixtureTracker, centerId: string, profileId: string, opts?: { count?: number; size?: string }
): Promise<{ productId: string; membershipId: string }> {
  const count = opts?.count ?? 4;
  const size = opts?.size ?? "240";
  const prod = await admin.from("products").insert({
    center_id: centerId, name: qaName(t.runId, "피겨화 대여"), price: 0, pass_type: "count", total_count: count,
    product_kind: "goods", sizes: [size], is_active: true, is_on_sale: false,
  }).select("id").single();
  if (prod.error || !prod.data) throw new Error(`QA 대여상품 생성 실패: ${prod.error?.message}`);
  t.add("products", prod.data.id);
  const mem = await admin.from("memberships").insert({
    profile_id: profileId, center_id: centerId, product_id: prod.data.id, product_name: qaName(t.runId, "피겨화 대여"),
    pass_type: "count", total_count: count, remaining_count: count, selected_size: size,
    starts_at: dateStr(0), expires_at: dateStr(60), status: "active",
  }).select("id").single();
  if (mem.error || !mem.data) throw new Error(`QA 대여상품 지급 실패: ${mem.error?.message}`);
  t.add("memberships", mem.data.id);
  return { productId: prod.data.id as string, membershipId: mem.data.id as string };
}

// 일반 count pass 상품(정상 판매 상태). QA 센터가 internal이라 일반 사용자에게는 노출되지 않는다.
export async function createQaPassProduct(
  admin: SupabaseClient, t: FixtureTracker, centerId: string, opts?: { price?: number; totalCount?: number }
): Promise<{ productId: string; name: string; price: number; totalCount: number }> {
  const price = opts?.price ?? 50000;
  const totalCount = opts?.totalCount ?? 10;
  const name = qaName(t.runId, `직접결제 ${totalCount}회 수강권`);
  const { data, error } = await admin.from("products").insert({
    center_id: centerId, name, price, pass_type: "count", total_count: totalCount, product_kind: "pass",
    is_active: true, is_on_sale: true, visibility_type: "all", expiry_mode: "none", unlimited: false, unlimited_pass: false,
  }).select("id").single();
  if (error || !data) throw new Error(`QA 수강권 상품 생성 실패: ${error?.message}`);
  t.add("products", data.id);
  return { productId: data.id as string, name, price, totalCount };
}
