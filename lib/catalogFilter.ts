/*
  수강권·상품 목록 검색/필터 공용 순수 로직(2026-10-01).
  회원 구매 sheet(app/center/[id])와 관리자 수강권 설정(app/manager/membership-rules)이 같은 규칙을 쓴다.
  - 이미 받아 온 배열을 클라이언트에서 거르기만 한다(새 API/SQL 없음, 기존 정렬 순서 유지).
  - 필터는 AND: 종류(전체/수강권/상품) AND 그룹(products.group_label, 센터가 실제로 쓰는 값을 동적으로 수집) AND 검색어.
  - 검색: trim + 소문자 + 공백 정규화 후 이름/그룹/설명 includes.
*/
export type KindFilter = "all" | "pass" | "goods";

export type CatalogItem = {
  name: string;
  kind?: "pass" | "goods" | string | null;
  groupLabel?: string | null;
  description?: string | null;
};

export type CatalogFilterState = { kind: KindFilter; group: string | null; query: string };
export const EMPTY_CATALOG_FILTER: CatalogFilterState = { kind: "all", group: null, query: "" };

export function normalizeQuery(q: string | null | undefined): string {
  return (q ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

const norm = (s: string | null | undefined) => normalizeQuery(s);

export function matchesQuery(item: CatalogItem, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return norm(item.name).includes(normalizedQuery)
    || norm(item.groupLabel).includes(normalizedQuery)
    || norm(item.description).includes(normalizedQuery);
}

const isGoods = (i: CatalogItem) => i.kind === "goods";

// 센터가 실제로 쓰는 group_label(수강권만, 빈값 제외, 처음 등장한 순서 유지, 중복 제거).
export function uniqueGroupLabels(items: CatalogItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    if (isGoods(i)) continue;
    const g = (i.groupLabel ?? "").trim();
    if (g && !seen.has(g)) { seen.add(g); out.push(g); }
  }
  return out;
}

// 순서를 바꾸지 않고 조건에 맞는 항목만 남긴다.
export function filterCatalog<T extends CatalogItem>(items: T[], f: CatalogFilterState): T[] {
  const q = normalizeQuery(f.query);
  return items.filter((i) => {
    if (f.kind === "pass" && isGoods(i)) return false;
    if (f.kind === "goods" && !isGoods(i)) return false;
    if (f.group && (isGoods(i) || (i.groupLabel ?? "").trim() !== f.group)) return false;
    return matchesQuery(i, q);
  });
}

export function isFilterActive(f: CatalogFilterState): boolean {
  return f.kind !== "all" || f.group !== null || normalizeQuery(f.query) !== "";
}

// 종류를 바꿀 때 그룹 필터가 더는 의미 없으면 풀어 준다(상품 탭에서는 그룹 chip이 없음).
export function nextFilterOnKind(f: CatalogFilterState, kind: KindFilter): CatalogFilterState {
  return { ...f, kind, group: kind === "goods" ? null : f.group };
}

// 목록이 비었을 때 보여줄 문구: 전체 항목이 0개인 경우와 검색/필터 결과가 0개인 경우를 구분한다.
export function catalogEmptyMessage(totalCount: number, f: CatalogFilterState, noun = "수강권·상품"): string {
  if (totalCount === 0) return `현재 판매 중인 ${noun}이 없어요`;
  const q = f.query.trim();
  if (q) return `'${q}' 검색 결과가 없어요`;
  return `조건에 맞는 ${noun}이 없어요`;
}
