/*
  센터 구매 sheet(app/center/[id]/page.tsx)의 수강권·상품 검색/필터 연결(2026-10-01) — 정적 계약 + 필터 후 상태 보존 설계.
  필터링 규칙 자체(AND, 정규화, 동적 그룹, 정렬 유지)는 tests/unit/catalogFilter.test.ts가 실제 함수 호출로 검증한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_CATALOG_FILTER, filterCatalog, nextFilterOnKind, uniqueGroupLabels } from "../../lib/catalogFilter";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const page = read("app/center/[id]/page.tsx");
const css = read("app/globals.css");

describe("검색/필터 연결", () => {
  it("공용 로직/컴포넌트를 import해 sheet title 아래에 sticky 검색/필터를 렌더한다", () => {
    for (const sym of ["filterCatalog", "uniqueGroupLabels", "nextFilterOnKind", "catalogEmptyMessage", "isFilterActive", "CatalogSearchFilter"]) {
      expect(page, sym).toContain(sym);
    }
    const titleIdx = page.indexOf("수강권 · 상품 구매");
    const filterIdx = page.indexOf("<CatalogSearchFilter");
    const listIdx = page.indexOf("classScopedProducts.length === 0 ? (");
    expect(titleIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(titleIdx);
    expect(listIdx).toBeGreaterThan(filterIdx);
  });
  it("placeholder '수강권·상품 검색', 종류 전체/수강권/상품, 그룹 chip은 products의 group_label에서 동적 수집(하드코딩 없음)", () => {
    expect(page).toContain('placeholder="수강권·상품 검색"');
    expect(page).toContain("uniqueGroupLabels(classScopedProducts)");
    expect(page).not.toMatch(/["']요일고정["']|["']자유이용["']/);
    expect(read("app/components/CatalogSearchFilter.tsx")).toContain('{ id: "pass", label: "수강권" }');
  });
  it("종류를 상품으로 바꾸면 그룹 필터 해제(nextFilterOnKind), 검색어 clear는 필터 유지(query만 변경)", () => {
    expect(page).toContain("nextFilterOnKind(f, k)");
    expect(page).toContain("onQuery={(q) => setCatalogFilter((f) => ({ ...f, query: q }))}");
    expect(nextFilterOnKind({ ...EMPTY_CATALOG_FILTER, kind: "pass", group: "자유이용" }, "goods").group).toBeNull();
  });
  it("계산은 useMemo로(매 render 재계산 방지), 서버 요청 없음, 기존 수업 지정 필터와 AND", () => {
    expect(page).toContain("const catalogProducts = useMemo(");
    expect(page).toContain("filterCatalog(classScopedProducts, effectiveCatalogFilter)");
    expect(page).toContain("filterProductIds.has(p.id)");
  });
  it("결과 0건 vs 전체 0개 구분 + [필터 초기화], 작은 결과 개수 텍스트", () => {
    expect(page).toContain("catalogEmptyMessage(classScopedProducts.length, effectiveCatalogFilter)");
    expect(page).toContain("catalogEmptyMessage(0, EMPTY_CATALOG_FILTER)");
    expect(page).toContain("필터 초기화");
    expect(page).toContain("setCatalogFilter(EMPTY_CATALOG_FILTER)");
    expect(page).toContain("resultText={filterActive ? `${visibleProducts.length}개` : null}");
  });
});

describe("빈 section header 없음 / 정렬 유지", () => {
  it("section(수강권/상품/그룹)은 결과가 있을 때만 header를 그린다", () => {
    expect(page).toContain('visibleProducts.filter((p) => p.kind === "pass").length > 0 && (');
    expect(page).toContain('visibleProducts.filter((p) => p.kind === "goods").length > 0 && (');
    // groupByLabel은 항목이 있는 그룹만 만든다
    const fn = page.slice(page.indexOf("function groupByLabel"), page.indexOf("export default function CenterDetailPage"));
    expect(fn).toContain("map.get(item.groupLabel)!.push(item)");
    expect(fn).not.toMatch(/order\.push\([^)]*\);\s*\}\s*\n\s*result\.push\(\{ label: key, items: \[\]/);
  });
  it("필터는 항목만 제거(상대 순서 유지) — 자유이용 + 수강권", () => {
    const items = [
      { name: "A", kind: "pass" as const, groupLabel: "자유이용" }, { name: "B", kind: "pass" as const, groupLabel: "요일고정" },
      { name: "C", kind: "pass" as const, groupLabel: "자유이용" }, { name: "D", kind: "goods" as const, groupLabel: null },
    ];
    expect(filterCatalog(items, { kind: "pass", group: "자유이용", query: "" }).map((i) => i.name)).toEqual(["A", "C"]);
    expect(uniqueGroupLabels(items)).toEqual(["자유이용", "요일고정"]);
  });
});

describe("[24] 필터/검색을 바꿔도 장바구니·선택 count/size 유지", () => {
  it("상품별 선택(횟수/사이즈)은 row 안이 아니라 상위 state(selections)에 있고 row는 value/onChange로 제어된다", () => {
    expect(page).toContain("const [selections, setSelections] = useState<Record<string, Partial<ProductSelection>>>({});");
    expect(page).toContain("value={selections[p.id]}");
    expect(page).toContain("onChange={changeSelection}");
    const row = page.slice(page.indexOf("function CenterProductRow"));
    expect(row).not.toMatch(/useState/);   // row가 unmount돼도 잃을 로컬 선택 state가 없다
  });
  it("필터 state를 바꾸는 코드는 장바구니/선택 state를 건드리지 않는다(cart는 서버 row, selections는 별도)", () => {
    const handlers = page.slice(page.indexOf("<CatalogSearchFilter"), page.indexOf("classScopedProducts.length === 0 ? ("));
    expect(handlers).not.toMatch(/setSelections|addToCart|clearCart|removeFromCart/);
  });
});

describe("[19] 모바일/Bottom Sheet 충돌 없음", () => {
  it("검색 input 16px(iOS 확대 방지), chip 가로 스크롤 한 줄(페이지 overflow 없음), 긴 라벨 ellipsis", () => {
    expect(css).toMatch(/\.catalog-search-input\s*\{[^}]*font-size:\s*16px/);
    expect(css).toMatch(/\.catalog-chips\s*\{[^}]*overflow-x:\s*auto[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.catalog-chips \.filter-chip\s*\{[^}]*text-overflow:\s*ellipsis/);
  });
  it("sticky 검색/필터는 sticky 제목(.sheet-title top:-22px, z-index 2) 바로 아래(top:18px)에 낮은 z-index로 붙어 제목/닫기 버튼과 겹치지 않는다", () => {
    const titleRule = css.slice(css.indexOf(".sheet-title {"), css.indexOf(".sheet-title {") + 300);
    expect(titleRule).toContain("position: sticky; top: -22px");
    expect(titleRule).toContain("z-index: 2");
    expect(css).toContain(".sheet .catalog-filter.is-sticky { top: 18px; z-index: 1; }");
  });
  it("drag-to-dismiss는 handle에서 시작한 제스처만(검색 input/chip 스크롤은 영향 없음)", () => {
    expect(read("lib/sheetDrag.ts")).toMatch(/handle/);
    expect(read("app/components/SheetOverlay.tsx")).toContain("sheet-drag-handle");
  });
});
