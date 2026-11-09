/*
  주문 직전 옵션(사이즈·횟수) 검증 — 순수 함수. 결제 화면과 장바구니가 같은 기준을 쓴다.
  - 사이즈가 있는 상품은 "지금 상품에 정의된 사이즈" 중 하나여야 한다(상품 옵션이 바뀐 뒤 남은 옛 선택값 거부).
  - 사이즈가 없는 상품에 사이즈를 실어 보내지 않는다.
  - 횟수 선택형 상품은 가격표에 있는 횟수여야 하고, 고정 상품은 횟수를 보내지 않는다.
  최종 금액·횟수는 서버가 주문 snapshot 으로 다시 확정한다(여기는 잘못된 주문을 만들기 전에 막는 UX 방어선).
*/
import { tierPriceFor, type CountTier } from "./selectableCount";

export type OrderOptionInput = {
  productName: string;
  sizes: string[] | null | undefined;
  selectedSize: string | null | undefined;
  countSelectable: boolean;
  countPrices?: CountTier[];
  selectedCount: number | null | undefined;
};

export type OrderOptionIssue = { kind: "size-required" | "size-invalid" | "size-unexpected" | "count-required" | "count-invalid" | "count-unexpected"; message: string };

export function orderOptionIssue(i: OrderOptionInput): OrderOptionIssue | null {
  const hasSizes = !!i.sizes && i.sizes.length > 0;
  if (hasSizes) {
    if (!i.selectedSize) return { kind: "size-required", message: `'${i.productName}'의 사이즈를 선택해주세요` };
    if (!i.sizes!.includes(i.selectedSize)) return { kind: "size-invalid", message: `'${i.productName}'의 사이즈 옵션이 바뀌었어요. 사이즈를 다시 선택해주세요` };
  } else if (i.selectedSize) {
    return { kind: "size-unexpected", message: `'${i.productName}'에는 사이즈 선택이 없어요. 장바구니에서 삭제하고 다시 담아주세요` };
  }
  if (i.countSelectable) {
    if (i.selectedCount == null) return { kind: "count-required", message: `'${i.productName}'의 구매 횟수를 선택해주세요` };
    if (tierPriceFor({ countPrices: i.countPrices }, i.selectedCount) == null) return { kind: "count-invalid", message: `'${i.productName}'의 횟수 옵션이 바뀌었어요. 횟수를 다시 선택해주세요` };
  } else if (i.selectedCount != null) {
    return { kind: "count-unexpected", message: `'${i.productName}'은 횟수를 고를 수 없는 상품이에요. 장바구니에서 삭제하고 다시 담아주세요` };
  }
  return null;
}

/** 목록에서 첫 문제 하나(없으면 null). */
export function firstOrderOptionIssue(items: OrderOptionInput[]): OrderOptionIssue | null {
  for (const it of items) { const x = orderOptionIssue(it); if (x) return x; }
  return null;
}
