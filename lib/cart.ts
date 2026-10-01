/*
  장바구니
  - 수강권/상품을 담아 한 번에 결제
  - cart_items 테이블 사용 (회원 본인 것만)
*/

import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";
import type { CountTier } from "./selectableCount";

export type CartItem = {
  id: string;
  centerId: string;
  productId: string;
  productName: string;
  price: number;
  selectedSize: string | null;
  sizes: string[] | null;   // 이 상품의 선택 가능한 사이즈
  // 2026-10-01 — 구매 횟수 선택형(회차별 가격표, add_selectable_count_pricing.sql). 고정 상품은 null/false/[].
  selectedCount: number | null;
  countSelectable: boolean;
  countPrices: CountTier[];   // 이 상품의 회차별 가격표. price(=장바구니 row 금액)는 선택 회차의 가격 snapshot(표시용).
};

async function myProfileId(): Promise<string> {
  const accountId = await getMyAccountId();
  if (!accountId) throw new Error("로그인이 필요해요");
  // 대표 프로필 우선, 없으면 가장 먼저 만든 프로필 사용 (single() 실패 방지)
  const { data: profs } = await supabase
    .from("profiles").select("id, is_primary, created_at")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  const prof = profs?.[0];
  if (!prof) throw new Error("프로필을 찾을 수 없어요. 프로필 관리에서 프로필을 만들어주세요.");
  return prof.id;
}

// 장바구니 정책(2026-10-01): 구매 횟수 선택형 상품은 "상품(+사이즈)당 한 row"만 허용한다. 같은 상품+같은 사이즈를 다시 담으면
// 새 row를 만들지 않고 기존 row의 선택 횟수를 새로 고른 값으로 "변경"한다(합산하면 max 초과/의도치 않은 횟수 증가가 생겨
// 가장 단순·안전한 변경 방식을 택함). 같은 상품이라도 사이즈가 다르면(5회/240 vs 3회/245) 서로 다른 row다.
// 고정 상품은 기존대로 담을 때마다 row가 하나씩 늘어난다(행 개수 = 수량).
// 장바구니 금액은 표시용 snapshot이고, 주문 생성 시 서버(orders 트리거)가 가격표에서 다시 확정한다.
export async function addToCart(input: {
  centerId: string; productId: string; productName: string; price: number; selectedSize?: string | null;
  selectedCount?: number | null;
}): Promise<void> {
  const profileId = await myProfileId();
  if (input.selectedCount != null) {
    let q = supabase.from("cart_items").select("id")
      .eq("profile_id", profileId).eq("product_id", input.productId).not("selected_count", "is", null);
    q = input.selectedSize ? q.eq("selected_size", input.selectedSize) : q.is("selected_size", null);
    const { data: existing } = await q.limit(1);
    if (existing && existing.length > 0) {
      const { error } = await supabase.from("cart_items")
        .update({ selected_count: input.selectedCount, price: input.price }).eq("id", (existing[0] as any).id);
      if (error) throw new Error("장바구니 담기에 실패했어요: " + error.message);
      return;
    }
  }
  const row: Record<string, unknown> = {
    profile_id: profileId,
    center_id: input.centerId,
    product_id: input.productId,
    product_name: input.productName,
    price: input.price,
    selected_size: input.selectedSize ?? null,
    selected_count: input.selectedCount ?? null,
  };
  let { error } = await supabase.from("cart_items").insert(row);
  if (error?.code === "42703" && input.selectedCount == null) {
    // add_selectable_count_pricing.sql 미적용 환경 — 고정 상품은 기존 방식 그대로 담는다.
    const { selected_count, ...legacy } = row;
    ({ error } = await supabase.from("cart_items").insert(legacy));
  } else if (error?.code === "42703") {
    throw new Error("횟수 선택 상품은 아직 장바구니에 담을 수 없어요. 바로 구매해주세요.");
  }
  if (error) throw new Error("장바구니 담기에 실패했어요: " + error.message);
}

export async function fetchCart(): Promise<CartItem[]> {
  const run = (cols: string) => supabase.from("cart_items").select(cols).order("created_at", { ascending: true });
  const first = await run("id, center_id, product_id, product_name, price, selected_size, selected_count, products(sizes, purchase_count_selectable)");
  let data: any[] | null = first.data as any;
  let error = first.error;
  if (error?.code === "42703") {
    ({ data, error } = (await run("id, center_id, product_id, product_name, price, selected_size, products(sizes)")) as any);
  }
  if (error) throw new Error("장바구니를 불러오지 못했어요: " + error.message);
  // 선택형 상품의 회차별 가격표를 한 번에 조회(없거나 실패하면 빈 가격표 — 그 row는 횟수를 바꿀 수 없고 저장된 금액으로만 표시)
  const rows = (data ?? []) as any[];
  const selectableIds = Array.from(new Set(rows.filter((c) => c.products?.purchase_count_selectable).map((c) => c.product_id)));
  const tiersByProduct: Record<string, CountTier[]> = {};
  if (selectableIds.length > 0) {
    const { data: tierRows, error: tierErr } = await supabase
      .from("product_count_prices").select("product_id, count, price").in("product_id", selectableIds);
    if (!tierErr) {
      for (const t of (tierRows ?? []) as any[]) (tiersByProduct[t.product_id] ??= []).push({ count: t.count, price: t.price });
      for (const id of Object.keys(tiersByProduct)) tiersByProduct[id].sort((a, b) => a.count - b.count);
    }
  }
  return rows.map((c: any) => ({
    id: c.id, centerId: c.center_id, productId: c.product_id,
    productName: c.product_name, price: c.price, selectedSize: c.selected_size,
    sizes: c.products?.sizes ?? null,
    selectedCount: c.selected_count ?? null,
    countSelectable: !!c.products?.purchase_count_selectable,
    countPrices: tiersByProduct[c.product_id] ?? [],
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

// 선택형 장바구니 row의 횟수 변경(금액 snapshot도 함께 갱신)
export async function updateCartCount(id: string, count: number, price: number): Promise<void> {
  const { error } = await supabase.from("cart_items").update({ selected_count: count, price }).eq("id", id);
  if (error) throw new Error("횟수 변경에 실패했어요: " + error.message);
}
