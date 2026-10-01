/*
  수강권(pass)/상품(goods) 공통 "구매자가 횟수 선택 + 회차별 개별 가격표"의 공용 순수 로직
  (2026-10-01, add_selectable_count_pricing.sql).
  - 가격표(product_count_prices)에 등록된 회차만 구매 가능하고, 회차별 가격은 서로 독립적이다
    (예: 1회 6,000 · 6회 34,000 — unit×count가 아니다).
  - 선택형 상품의 products.price는 호환 값(가격표 최저가)일 뿐이고, 주문 금액은 항상 가격표에서 온다.
  - 고정 상품(purchase_count_selectable=false)은 기존대로 price = 총 상품가, total_count = 총 횟수.
  - 아래 계산은 화면 표시용 미리보기다. 최종 금액/발급 횟수는 서버가 주문 snapshot으로 다시 확정한다
    (orders.selected_count, orders.product_amount_snapshot — 클라이언트의 금액/횟수를 신뢰하지 않음).
  - products.max_quantity("판매 가능한 membership 개수")와 selected_count("이번 구매의 이용 횟수")는 완전히 다른 개념이다.
*/
export type CountTier = { count: number; price: number };

export type CountSelectableInfo = {
  price: number;                       // 선택형이면 호환 값(최저가), 고정이면 총 가격
  countSelectable: boolean;
  countPrices?: CountTier[];           // 로그인 회원/관리자 조회에서는 전체 가격표
  // 공개(비로그인) RPC는 가격표 요약만 준다
  minCount?: number | null;
  maxCount?: number | null;
  minTierPrice?: number | null;
};

export function sortedTiers(p: Pick<CountSelectableInfo, "countPrices">): CountTier[] {
  return [...(p.countPrices ?? [])].sort((a, b) => a.count - b.count);
}

export function isCountSelectable(p: Pick<CountSelectableInfo, "countSelectable" | "countPrices" | "minCount" | "maxCount">): boolean {
  if (!p.countSelectable) return false;
  return (p.countPrices?.length ?? 0) > 0 || (p.minCount != null && p.maxCount != null && p.minCount >= 1);
}

export function countOptions(p: Pick<CountSelectableInfo, "countPrices">): number[] {
  return sortedTiers(p).map((t) => t.count);
}

export function tierPriceFor(p: Pick<CountSelectableInfo, "countPrices">, count: number | null | undefined): number | null {
  if (count == null) return null;
  return (p.countPrices ?? []).find((t) => t.count === count)?.price ?? null;
}

export function isValidSelectedCount(p: CountSelectableInfo, count: number | null | undefined): boolean {
  if (!p.countSelectable) return count == null;          // 고정 상품은 횟수를 선택할 수 없다
  return tierPriceFor(p, count) != null;                 // 가격표에 있는 회차만
}

// 상품 기본금액(쿠폰/포인트 적용 전). 선택형=가격표의 그 회차 가격, 고정=상품가. 가격표에 없는 횟수면 null.
export function computeBaseAmount(p: CountSelectableInfo, count: number | null | undefined): number | null {
  if (!p.countSelectable) return p.price;
  return tierPriceFor(p, count);
}

const won = (n: number) => n.toLocaleString("ko-KR") + "원";

// 드롭다운 옵션 라벨: "4회 · 300,000원"
export function countOptionLabel(t: CountTier): string {
  return `${t.count}회 · ${won(t.price)}`;
}

// 목록/공개 페이지용 가격 문구: 선택형 "1~12회 선택 · 6,000원부터" / 고정 "4회 · 24,000원"(totalCount 없으면 금액만)
export function priceSummary(p: CountSelectableInfo & { totalCount?: number | null; unlimited?: boolean }): string {
  if (isCountSelectable(p)) {
    const tiers = sortedTiers(p);
    const minC = tiers.length ? tiers[0].count : p.minCount!;
    const maxC = tiers.length ? tiers[tiers.length - 1].count : p.maxCount!;
    const minP = tiers.length ? Math.min(...tiers.map((t) => t.price)) : (p.minTierPrice ?? p.price);
    const range = minC === maxC ? `${minC}회` : `${minC}~${maxC}회 선택`;
    return `${range} · ${won(minP)}부터`;
  }
  const count = p.unlimited ? "무제한" : p.totalCount ? `${p.totalCount}회` : "";
  return count ? `${count} · ${won(p.price)}` : won(p.price);
}

// 남은 "판매 가능 수량"(products.max_quantity 기준, 이용 횟수와 무관). 표시할 필요가 없으면 null.
//  - max_quantity 없음(null)  → 표시 안 함 / 0 → "매진" / 1 이상 → "판매 가능 N개"
export function availabilityLabel(remaining: number | null | undefined): string | null {
  if (remaining == null) return null;
  if (remaining <= 0) return "매진";
  return `판매 가능 ${remaining}개`;
}

// 장바구니 row 금액(표시용): 선택형이면 가격표의 선택 회차 가격, 아니면 row에 저장된 금액. 서버가 주문 생성 시 다시 확정한다.
export function cartItemAmount(i: {
  price: number; countSelectable: boolean; countPrices?: CountTier[]; selectedCount: number | null;
}): number {
  if (!i.countSelectable) return i.price;
  return tierPriceFor(i, i.selectedCount) ?? i.price;
}

// 관리자 편의: "기준 1회 가격"으로 1..maxCount회 가격표를 자동 채운다(unit×count). 최종 가격은 관리자가 행별로 수정한 저장 값이다.
export function fillTiersFromUnit(unitPrice: number, maxCount = 12): CountTier[] {
  if (!(unitPrice > 0) || !(maxCount >= 1)) return [];
  return Array.from({ length: maxCount }, (_, i) => ({ count: i + 1, price: unitPrice * (i + 1) }));
}

export type TierDraft = { count: number; price: string; enabled: boolean };

// 가격표 입력 검증(관리자 폼). 서버(set_product_count_prices)가 같은 규칙을 다시 검증한다.
export function validateTierDrafts(rows: TierDraft[]): string | null {
  const on = rows.filter((r) => r.enabled);
  if (on.length === 0) return "판매할 횟수와 가격을 1개 이상 입력해주세요";
  const seen = new Set<number>();
  for (const r of on) {
    if (!(Number.isInteger(r.count) && r.count >= 1)) return "횟수는 1회 이상이어야 해요";
    if (seen.has(r.count)) return "같은 횟수를 두 번 등록할 수 없어요";
    seen.add(r.count);
    const n = Number(r.price.replace(/[^0-9]/g, ""));
    if (!(n > 0)) return `${r.count}회 가격을 0원보다 크게 입력해주세요`;
  }
  return null;
}

export function draftsToTiers(rows: TierDraft[]): CountTier[] {
  return rows.filter((r) => r.enabled).map((r) => ({ count: r.count, price: Number(r.price.replace(/[^0-9]/g, "")) }));
}
