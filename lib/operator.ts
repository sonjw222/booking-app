/*
  운영자 설정 데이터
  - 종목(service_categories) 관리
  - 홈 배너(home_banners) 관리
  - 구독 플랜(subscription_plans) 관리 — 센터가 플랫폼에 내는 월 구독료 플랜 카탈로그.
    실제 제한 강제는 DB 트리거가 담당(add_subscription_plan_limits.sql 참고) — 여기는
    그 트리거가 참조하는 숫자만 편집한다.
  운영자(is_platform_admin)만 쓰기 가능, 조회는 공개
*/

import { supabase } from "./supabaseClient";

export type ServiceCategory = {
  id: string;
  label: string;
  emoji: string | null;
  sortOrder: number;
};

export type HomeBanner = {
  id: string;
  title: string;
  subtitle: string | null;
  emoji: string | null;
  linkUrl: string | null;
  isActive: boolean;
  sortOrder: number;
};

// --- 종목 ---
export async function fetchCategories(): Promise<ServiceCategory[]> {
  const { data, error } = await supabase
    .from("service_categories")
    .select("id, label, emoji, sort_order")
    .order("sort_order", { ascending: true });
  if (error) throw new Error("종목을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((c: any) => ({ id: c.id, label: c.label, emoji: c.emoji, sortOrder: c.sort_order }));
}

export async function addCategory(label: string, emoji: string): Promise<void> {
  const { error } = await supabase.from("service_categories").insert({ label, emoji: emoji || null });
  if (error) {
    if (error.message.includes("duplicate")) throw new Error("이미 있는 종목이에요");
    throw new Error("종목 추가에 실패했어요: " + error.message);
  }
}

export async function deleteCategory(id: string): Promise<void> {
  const { error } = await supabase.from("service_categories").delete().eq("id", id);
  if (error) throw new Error("종목 삭제에 실패했어요: " + error.message);
}

// --- 배너 ---
export async function fetchBanners(activeOnly = false): Promise<HomeBanner[]> {
  let q = supabase
    .from("home_banners")
    .select("id, title, subtitle, emoji, link_url, is_active, sort_order")
    .order("sort_order", { ascending: true });
  if (activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q;
  if (error) throw new Error("배너를 불러오지 못했어요: " + error.message);
  return (data ?? []).map((b: any) => ({
    id: b.id, title: b.title, subtitle: b.subtitle, emoji: b.emoji,
    linkUrl: b.link_url, isActive: b.is_active, sortOrder: b.sort_order,
  }));
}

export async function addBanner(b: { title: string; subtitle: string; emoji: string; linkUrl: string }): Promise<void> {
  const { error } = await supabase.from("home_banners").insert({
    title: b.title, subtitle: b.subtitle || null, emoji: b.emoji || null, link_url: b.linkUrl || null,
  });
  if (error) throw new Error("배너 추가에 실패했어요: " + error.message);
}

export async function toggleBanner(id: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from("home_banners").update({ is_active: isActive }).eq("id", id);
  if (error) throw new Error("배너 상태 변경에 실패했어요: " + error.message);
}

export async function deleteBanner(id: string): Promise<void> {
  const { error } = await supabase.from("home_banners").delete().eq("id", id);
  if (error) throw new Error("배너 삭제에 실패했어요: " + error.message);
}

// --- 구독 플랜 ---
// max_* 필드가 null이면 무제한(화면에서는 "무제한" 토글로 표현, null ↔ 숫자 왕복).
export type SubscriptionPlan = {
  id: string;
  name: string;
  monthlyPrice: number;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  maxRooms: number | null;
  maxStaff: number | null;
  maxMembers: number | null;
  maxProducts: number | null;
};

export type SubscriptionPlanInput = {
  name: string;
  monthlyPrice: number;
  description: string;
  isActive: boolean;
  maxRooms: number | null;
  maxStaff: number | null;
  maxMembers: number | null;
  maxProducts: number | null;
};

function rowToPlan(r: any): SubscriptionPlan {
  return {
    id: r.id, name: r.name, monthlyPrice: r.monthly_price, description: r.description,
    isActive: r.is_active, isDefault: r.is_default,
    maxRooms: r.max_rooms, maxStaff: r.max_staff, maxMembers: r.max_members, maxProducts: r.max_products,
  };
}

const PLAN_COLUMNS = "id, name, monthly_price, description, is_active, is_default, max_rooms, max_staff, max_members, max_products";

export async function fetchSubscriptionPlans(): Promise<SubscriptionPlan[]> {
  const { data, error } = await supabase.from("subscription_plans").select(PLAN_COLUMNS).order("created_at", { ascending: true });
  if (error) throw new Error("구독 플랜을 불러오지 못했어요: " + error.message);
  return (data ?? []).map(rowToPlan);
}

export async function createSubscriptionPlan(input: SubscriptionPlanInput): Promise<void> {
  const { error } = await supabase.from("subscription_plans").insert({
    name: input.name, monthly_price: input.monthlyPrice, description: input.description || null,
    is_active: input.isActive,
    max_rooms: input.maxRooms, max_staff: input.maxStaff, max_members: input.maxMembers, max_products: input.maxProducts,
  });
  if (error) throw new Error("플랜 추가에 실패했어요: " + error.message);
}

export async function updateSubscriptionPlan(id: string, input: SubscriptionPlanInput): Promise<void> {
  const { error } = await supabase.from("subscription_plans").update({
    name: input.name, monthly_price: input.monthlyPrice, description: input.description || null,
    is_active: input.isActive,
    max_rooms: input.maxRooms, max_staff: input.maxStaff, max_members: input.maxMembers, max_products: input.maxProducts,
  }).eq("id", id);
  if (error) throw new Error("플랜 수정에 실패했어요: " + error.message);
}

// 이미 그 플랜을 쓰는 센터가 있으면 FK 제약(center_subscriptions.plan_id)에 걸려 삭제가
// 거부된다(23503) — 그 경우 "비활성화하세요" 안내로 바꿔서 던진다.
export async function deleteSubscriptionPlan(id: string): Promise<void> {
  const { error } = await supabase.from("subscription_plans").delete().eq("id", id);
  if (error) {
    if (error.code === "23503") {
      throw new Error("이 플랜을 이미 쓰고 있는 센터가 있어 삭제할 수 없어요 — 대신 비활성화해주세요.");
    }
    throw new Error("플랜 삭제에 실패했어요: " + error.message);
  }
}

export async function setDefaultSubscriptionPlan(id: string): Promise<void> {
  const { error } = await supabase.rpc("set_default_subscription_plan", { p_plan_id: id });
  if (error) throw new Error("기본 플랜 지정에 실패했어요: " + error.message);
}
