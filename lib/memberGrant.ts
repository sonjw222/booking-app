/*
  관리자 회원 상세 "수강권 지급 / 상품 지급" 순수 로직(2026-10-01).
  - 수강권 지급 시트에는 goods가 나오지 않고, 상품 지급 시트에는 goods만 나온다.
  - 사이즈가 정의된 상품은 사이즈를 고르기 전에는 지급할 수 없다(선택값은 memberships.selected_size에 저장).
  - 회원 프로필의 shoe_size가 상품 sizes 중 하나와 일치하면 기본 선택값으로 "제안"만 한다(관리자가 바꿀 수 있음).
  UI 컴포넌트(app/manager/members/page.tsx)가 이 함수들만으로 버튼 활성/문구를 결정해 테스트로 고정한다.
*/
import { countOptions, isCountSelectable, tierPriceFor, type CountTier } from "./selectableCount";

export type GrantKind = "pass" | "goods";

export type GrantableProduct = {
  id: string;
  name: string;
  price: number;
  kind: "pass" | "goods";
  sizes: string[];
  weekdaySelectable: boolean;
  timeSelectable: boolean;
  onSale: boolean;
  // 구매 횟수 선택형(add_selectable_count_pricing.sql): 회차별 가격표(가격이 등록된 회차만 지급 가능, pass/goods 공통)
  countSelectable?: boolean;
  countPrices?: CountTier[];
};

export function filterGrantProducts<T extends { kind: "pass" | "goods" }>(products: T[], kind: GrantKind): T[] {
  return products.filter((p) => (kind === "goods" ? p.kind === "goods" : p.kind !== "goods"));
}

// 선택형 상품의 지급 횟수 후보(= 가격표에 등록된 회차)/기본 가격(= 그 회차의 가격표 가격, 관리자가 수정할 수 있고 0원이면 서비스 지급)
export function grantCountOptions(p: Pick<GrantableProduct, "countSelectable" | "countPrices"> | undefined | null): number[] {
  if (!p || !isCountSelectable({ countSelectable: !!p.countSelectable, countPrices: p.countPrices })) return [];
  return countOptions({ countPrices: p.countPrices });
}

export function defaultGrantPrice(p: GrantableProduct | undefined | null, count: number | null): number | null {
  if (!p) return null;
  if (grantCountOptions(p).length === 0) return p.price;   // 고정 상품은 상품가 그대로
  return tierPriceFor({ countPrices: p.countPrices }, count);   // 가격표에 없는 횟수면 null
}

export function productNeedsSize(p: Pick<GrantableProduct, "sizes"> | undefined | null): boolean {
  return !!p && Array.isArray(p.sizes) && p.sizes.length > 0;
}

const digits = (s: string) => s.replace(/[^0-9.]/g, "");

// 프로필 shoe_size가 상품 sizes 중 하나와 같으면(숫자 기준 "240" == "240mm") 그 값을 기본 선택으로 제안.
export function suggestGrantSize(p: Pick<GrantableProduct, "sizes">, shoeSize: string | null | undefined): string | null {
  if (!shoeSize || !productNeedsSize(p)) return null;
  const want = digits(shoeSize);
  if (!want) return null;
  return p.sizes.find((s) => s === shoeSize || digits(s) === want) ?? null;
}

// 지급 버튼을 막아야 하는 이유(없으면 null). 서버(manager_grant_product)가 같은 검증을 다시 한다.
export function grantBlockReason(input: {
  product: GrantableProduct | undefined;
  price: string;
  selectedSize: string | null;
  scheduleDay: number | null;
  scheduleTime: string | null;
  selectedCount?: number | null;   // 구매 횟수 선택형 상품에서만 사용
}): string | null {
  const { product } = input;
  if (!product) return "지급할 상품을 선택해주세요";
  if (input.price.trim() === "" || !Number.isFinite(Number(input.price)) || Number(input.price) < 0) return "가격을 숫자로 입력해주세요";
  const countChoices = grantCountOptions(product);
  if (countChoices.length > 0 && (input.selectedCount == null || !countChoices.includes(input.selectedCount))) return "지급할 횟수를 선택해주세요";
  if (productNeedsSize(product) && !input.selectedSize) return "사이즈를 선택해주세요";
  if (product.kind !== "goods" && product.weekdaySelectable && input.scheduleDay === null) return "이용 요일을 선택해주세요";
  if (product.kind !== "goods" && product.weekdaySelectable && product.timeSelectable && !input.scheduleTime) return "이용 시간을 선택해주세요";
  return null;
}

export function grantSheetTitle(memberName: string, kind: GrantKind): string {
  return `${memberName}님에게 ${kind === "goods" ? "상품" : "수강권"} 지급`;
}

// "피겨화 대여 4회 · 3회 남음 · 240mm" 형태의 보유 항목 요약
export function holdingLabel(h: { name: string; remaining: number | null; selectedSize?: string | null }): string {
  const parts = [h.name, h.remaining != null ? `${h.remaining}회 남음` : "무제한"];
  if (h.selectedSize) parts.push(h.selectedSize);
  return parts.join(" · ");
}
