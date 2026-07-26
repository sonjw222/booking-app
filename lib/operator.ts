/*
  운영자 설정 데이터
  - 종목(service_categories) 관리
  - 홈 배너(home_banners) 관리
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
