/*
  상품(/manager/goods)·수강권(/manager/membership-rules) 폼 공용 순수 로직 — 고정 횟수/가격 vs 구매자가 횟수 선택 + 회차별 가격표(2026-10-01).
  선택형의 가격은 회차마다 독립(add_selectable_count_pricing.sql의 product_count_prices) — unit×count가 아니다.
  서버(set_product_count_prices)가 같은 규칙을 다시 검증한다.
*/
import { fillTiersFromUnit, priceSummary, validateTierDrafts, type CountTier, type TierDraft } from "./selectableCount";

export type GoodsPricingMode = "fixed" | "selectable";

// 새 선택형 상품의 기본 "최대 횟수"(편집기가 처음 보여주는 행 수). 고정 한도가 아니다 — 관리자가 최대 횟수를 직접 정하고
// (센터마다 5·8·20·30회 등), 서버(product_count_prices)는 임의의 회차를 지원한다.
export const TIER_ROWS = 12;
export const MAX_TIER_COUNT = 100;   // 편집기 안전 상한(실수로 큰 수를 넣어 화면이 멈추는 것 방지)

export type GoodsFormInput = {
  mode: GoodsPricingMode;
  unlimited: boolean;
  price: number;          // 고정 상품 가격
  totalCount: number;     // 고정 상품 총 횟수
  tiers?: TierDraft[];    // 선택형 회차별 가격표(편집 중인 행)
};

// 저장 전 검증 메시지(없으면 null). 고정 상품은 기존 검증(무제한이 아니면 횟수 필수)을 그대로 유지한다.
export function validateGoodsForm(f: GoodsFormInput): string | null {
  if (f.mode === "selectable") {
    if (f.unlimited) return "구매자가 횟수를 선택하는 상품은 무제한으로 만들 수 없어요";
    return validateTierDrafts(f.tiers ?? []);
  }
  if (!f.unlimited && f.totalCount === 0) return "횟수를 입력해주세요";
  return null;
}

// 편집기 행 만들기: 1..rows회, 가격표에 있는 회차는 체크 + 가격 채움(저장된 회차가 12를 넘으면 그 회차까지 행 추가)
export function draftsFromTiers(tiers: CountTier[] | null | undefined, rows = TIER_ROWS): TierDraft[] {
  const byCount = new Map((tiers ?? []).map((t) => [t.count, t.price]));
  const maxC = Math.max(rows, ...(tiers ?? []).map((t) => t.count));
  return Array.from({ length: maxC }, (_, i) => {
    const count = i + 1;
    const price = byCount.get(count);
    return { count, price: price != null ? String(price) : "", enabled: price != null };
  });
}

// 행에 실제로 판매 중인 가격이 들어 있는지(체크 + 가격 입력). 축소 시 이 데이터는 조용히 지우지 않는다.
const isActiveDraft = (r: TierDraft) => r.enabled && r.price.replace(/[^0-9]/g, "") !== "";

// 가장 큰 "판매 중" 회차(없으면 0).
export function highestActiveCount(rows: TierDraft[]): number {
  return rows.reduce((m, r) => (isActiveDraft(r) ? Math.max(m, r.count) : m), 0);
}

// 편집기 행의 최대 회차(= 보여주는 행 수).
export function maxTierCount(rows: TierDraft[]): number {
  return rows.reduce((m, r) => Math.max(m, r.count), 0);
}

export type ResizeResult = {
  rows: TierDraft[];
  effectiveMax: number;        // 실제로 보여주는 최대 회차
  blockedBy: number | null;    // 요청한 최대 횟수보다 큰 회차에 판매 중인 가격이 있어 줄이지 못했다면 그 최대 회차
};

// 최대 횟수 변경 → 행 늘리기/줄이기. 기존 입력값은 항상 보존한다:
//  · 늘리기: 새 회차는 체크 해제 + 빈 가격으로 추가(기존 행/가격 불변)
//  · 줄이기: 큰 회차 중 "판매 중인 가격이 있는" 행이 있으면 그 회차까지는 남겨 두고 blockedBy로 알린다(조용히 삭제 금지).
//    관리자가 해당 회차의 체크를 해제하거나 가격을 지운 뒤에야 줄어든다. 데이터가 없는 큰 행만 제거한다.
export function resizeTierDrafts(rows: TierDraft[], requestedMax: number): ResizeResult {
  const want = Math.min(MAX_TIER_COUNT, Math.max(1, Math.floor(requestedMax) || 1));
  const byCount = new Map(rows.map((r) => [r.count, r]));
  const floor = highestActiveCount(rows);
  const effectiveMax = Math.max(want, floor);
  const next: TierDraft[] = Array.from({ length: effectiveMax }, (_, i) => {
    const count = i + 1;
    return byCount.get(count) ?? { count, price: "", enabled: false };
  });
  return { rows: next, effectiveMax, blockedBy: floor > want ? floor : null };
}

// "기준 1회 가격으로 채우기" — 모든 행을 체크하고 unit×count로 채운다(이후 행별 수정 가능, 저장 값이 authoritative).
export function fillDraftsFromUnit(unit: number, current: TierDraft[]): TierDraft[] {
  const filled = fillTiersFromUnit(unit, current.length || TIER_ROWS);
  return filled.map((t) => ({ count: t.count, price: String(t.price), enabled: true }));
}

// 목록 한 줄 요약. 고정 상품은 기존 표기("24,000원 · 4회")를 그대로 유지한다. 선택형은 "1~12회 선택 · 6,000원부터".
export function goodsListLabel(p: {
  price: number; unlimited: boolean; totalCount: number | null;
  countSelectable: boolean; countPrices: CountTier[];
}): string {
  const won = (n: number) => n.toLocaleString("ko-KR") + "원";
  if (p.countSelectable) {
    return p.countPrices.length > 0
      ? priceSummary({ price: p.price, countSelectable: true, countPrices: p.countPrices })
      : "가격표 미설정";
  }
  return `${won(p.price)} · ${p.unlimited ? "무제한" : `${p.totalCount ?? 0}회`}`;
}

// 모드 전환 시 충돌하는 입력 정리: 선택형은 항상 유한 횟수 상품이다.
export function nextUnlimitedForMode(mode: GoodsPricingMode, unlimited: boolean): boolean {
  return mode === "selectable" ? false : unlimited;
}
