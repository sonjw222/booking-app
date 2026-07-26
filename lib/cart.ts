/*
  장바구니
  - 수강권/상품을 담아 한 번에 결제
  - cart_items 테이블 사용 (회원 본인 것만)
*/

import { supabase } from "./supabaseClient";

export type CartItem = {
  id: string;
  centerId: string;
  productId: string;
  productName: string;
  price: number;
  selectedSize: string | null;
  sizes: string[] | null;   // 이 상품의 선택 가능한 사이즈
};

async function myProfileId(): Promise<string> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw new Error("로그인이 필요해요");
  const { data: acc } = await supabase.from("accounts").select("id").eq("auth_id", authData.user.id).single();
  if (!acc) throw new Error("계정을 찾을 수 없어요");
  // 대표 프로필 우선, 없으면 가장 먼저 만든 프로필 사용 (single() 실패 방지)
  const { data: profs } = await supabase
    .from("profiles").select("id, is_primary, created_at")
    .eq("account_id", acc.id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  const prof = profs?.[0];
  if (!prof) throw new Error("프로필을 찾을 수 없어요. 프로필 관리에서 프로필을 만들어주세요.");
  return prof.id;
}

export async function addToCart(input: {
  centerId: string; productId: string; productName: string; price: number; selectedSize?: string | null;
}): Promise<void> {
  const profileId = await myProfileId();
  const { error } = await supabase.from("cart_items").insert({
    profile_id: profileId,
    center_id: input.centerId,
    product_id: input.productId,
    product_name: input.productName,
    price: input.price,
    selected_size: input.selectedSize ?? null,
  });
  if (error) throw new Error("장바구니 담기에 실패했어요: " + error.message);
}

export async function fetchCart(): Promise<CartItem[]> {
  const { data, error } = await supabase
    .from("cart_items")
    .select("id, center_id, product_id, product_name, price, selected_size, products(sizes)")
    .order("created_at", { ascending: true });
  if (error) throw new Error("장바구니를 불러오지 못했어요: " + error.message);
  return (data ?? []).map((c: any) => ({
    id: c.id, centerId: c.center_id, productId: c.product_id,
    productName: c.product_name, price: c.price, selectedSize: c.selected_size,
    sizes: c.products?.sizes ?? null,
  }));
}

export async function removeFromCart(id: string): Promise<void> {
  const { error } = await supabase.from("cart_items").delete().eq("id", id);
  if (error) throw new Error("삭제에 실패했어요: " + error.message);
}

export async function clearCart(): Promise<void> {
  const profileId = await myProfileId();
  const { error } = await supabase.from("cart_items").delete().eq("profile_id", profileId);
  if (error) throw new Error("장바구니 비우기에 실패했어요: " + error.message);
}

export async function cartCount(): Promise<number> {
  const { count, error } = await supabase
    .from("cart_items")
    .select("id", { count: "exact", head: true });
  if (error) return 0;
  return count ?? 0;
}

// 장바구니 항목의 사이즈 선택/변경
export async function updateCartSize(id: string, size: string): Promise<void> {
  const { error } = await supabase.from("cart_items").update({ selected_size: size }).eq("id", id);
  if (error) throw new Error("사이즈 변경에 실패했어요: " + error.message);
}
