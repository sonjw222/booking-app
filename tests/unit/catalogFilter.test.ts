import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_CATALOG_FILTER, catalogEmptyMessage, filterCatalog, isFilterActive, nextFilterOnKind, normalizeQuery, uniqueGroupLabels,
  type CatalogItem,
} from "../../lib/catalogFilter";

const items: (CatalogItem & { id: string })[] = [
  { id: "a", name: "10월 어텐션 4주완성안무반 수강권", kind: "pass", groupLabel: "요일고정", description: null },
  { id: "b", name: "10월 요일고정 수강권", kind: "pass", groupLabel: "요일고정" },
  { id: "c", name: "10월 자유이용 수강권", kind: "pass", groupLabel: "자유이용" },
  { id: "d", name: "11월 수강권", kind: "pass", groupLabel: "자유이용", description: "안무 포함" },
  { id: "e", name: "성인반 4회", kind: "pass", groupLabel: "성인반" },
  { id: "f", name: "기타 수강권", kind: "pass", groupLabel: "" },
  { id: "g", name: "피겨화 대여", kind: "goods", groupLabel: null },
  { id: "h", name: "Helmet Rental", kind: "goods" },
];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join("");
const F = (p: Partial<typeof EMPTY_CATALOG_FILTER>) => ({ ...EMPTY_CATALOG_FILTER, ...p });

describe("회원 구매 필터 (1~5)", () => {
  it("전체 = pass + goods, 기존 순서 유지", () => expect(ids(filterCatalog(items, F({})))).toBe("abcdefgh"));
  it("수강권 = pass만 / 상품 = goods만", () => {
    expect(ids(filterCatalog(items, F({ kind: "pass" })))).toBe("abcdef");
    expect(ids(filterCatalog(items, F({ kind: "goods" })))).toBe("gh");
  });
  it("수강권 + 자유이용 / 요일고정", () => {
    expect(ids(filterCatalog(items, F({ kind: "pass", group: "자유이용" })))).toBe("cd");
    expect(ids(filterCatalog(items, F({ kind: "pass", group: "요일고정" })))).toBe("ab");
  });
  it("그룹은 goods를 제외한다(전체 + 그룹 = 해당 그룹 수강권만)", () => {
    expect(ids(filterCatalog(items, F({ group: "요일고정" })))).toBe("ab");
  });
});

describe("검색 (6~8, 정규화)", () => {
  it("'10월' → 이름에 10월 포함만", () => expect(ids(filterCatalog(items, F({ query: "10월" })))).toBe("abc"));
  it("수강권 + 요일고정 + 10월 → 세 조건 모두", () => {
    expect(ids(filterCatalog(items, F({ kind: "pass", group: "요일고정", query: "10월" })))).toBe("ab");
    expect(ids(filterCatalog(items, F({ kind: "pass", group: "자유이용", query: "10월" })))).toBe("c");
  });
  it("trim/대소문자/공백 정규화: ' 10월 ' == '10월', 'HELMET' == 'helmet', 여러 공백 하나로", () => {
    expect(ids(filterCatalog(items, F({ query: " 10월 " })))).toBe(ids(filterCatalog(items, F({ query: "10월" }))));
    expect(ids(filterCatalog(items, F({ query: "HELMET" })))).toBe("h");
    expect(normalizeQuery("  10월   자유이용 ")).toBe("10월 자유이용");
    expect(ids(filterCatalog(items, F({ query: "10월   자유이용" })))).toBe("c");
  });
  it("검색 대상 = 이름 + group_label + description", () => {
    expect(ids(filterCatalog(items, F({ query: "자유이용" })))).toBe("cd");   // c: 이름+그룹, d: 그룹
    expect(ids(filterCatalog(items, F({ query: "안무" })))).toBe("ad");        // a: 이름, d: 설명
    expect(ids(filterCatalog(items, F({ query: "피겨화" })))).toBe("g");
  });
  it("검색어만 지우면 필터는 유지된다", () => {
    const f = F({ kind: "pass", group: "요일고정", query: "10월" });
    const cleared = { ...f, query: "" };
    expect(cleared.kind).toBe("pass"); expect(cleared.group).toBe("요일고정");
    expect(ids(filterCatalog(items, cleared))).toBe("ab");
  });
  it("필터 초기화 → 전체 복구", () => {
    expect(isFilterActive(F({ query: "10월" }))).toBe(true);
    expect(isFilterActive(EMPTY_CATALOG_FILTER)).toBe(false);
    expect(ids(filterCatalog(items, EMPTY_CATALOG_FILTER))).toBe("abcdefgh");
  });
});

describe("동적 그룹 chip (16)", () => {
  it("센터가 쓰는 group_label만, 수강권에서만, 중복/빈값 제외, 등장 순서 유지 — 하드코딩 없음", () => {
    expect(uniqueGroupLabels(items)).toEqual(["요일고정", "자유이용", "성인반"]);
    expect(uniqueGroupLabels([...items, { name: "새", kind: "pass", groupLabel: "주말반" }])).toContain("주말반");
    expect(uniqueGroupLabels([{ name: "x", kind: "goods", groupLabel: "무시" }])).toEqual([]);
  });
  it("상품 탭으로 바꾸면 그룹 필터가 풀린다", () => {
    expect(nextFilterOnKind(F({ kind: "pass", group: "요일고정" }), "goods").group).toBeNull();
    expect(nextFilterOnKind(F({ kind: "all", group: "요일고정" }), "pass").group).toBe("요일고정");
  });
});

describe("빈 결과 (10)", () => {
  it("전체 0개 vs 검색 0개 vs 필터 0개 문구 구분", () => {
    expect(catalogEmptyMessage(0, EMPTY_CATALOG_FILTER)).toBe("현재 판매 중인 수강권·상품이 없어요");
    expect(catalogEmptyMessage(8, F({ query: "10월" }))).toBe("'10월' 검색 결과가 없어요");
    expect(catalogEmptyMessage(8, F({ kind: "goods", group: null }))).toBe("조건에 맞는 수강권·상품이 없어요");
  });
});

describe("선택형 횟수 상품 (12) · 정렬 (24)", () => {
  it("선택형 goods는 한 row로 취급되어 검색 결과에 한 번만 나온다(1~12회 12줄 아님)", () => {
    const selectable = [...items, { id: "s", name: "피겨화 대여", kind: "goods" as const }];
    expect(filterCatalog(selectable, F({ kind: "goods", query: "피겨화" })).map((x) => x.id)).toEqual(["g", "s"]);   // 입력에 있는 만큼만(중복 생성 없음)
    expect(filterCatalog(items, F({ kind: "goods", query: "피겨화" })).length).toBe(1);
  });
  it("필터는 항목을 제거할 뿐 상대 순서를 바꾸지 않는다", () => {
    const shuffled = [items[4], items[0], items[2], items[1]];
    expect(ids(filterCatalog(shuffled, F({ kind: "pass" })))).toBe("eacb");
  });
});

describe("컴포넌트/CSS 계약 (9, 10, 17~19, 22)", () => {
  const comp = readFileSync(join(__dirname, "../../app/components/CatalogSearchFilter.tsx"), "utf-8");
  const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
  it("접근성: 검색 aria-label, chip aria-pressed, 지우기 aria-label, 값이 있을 때만 X", () => {
    expect(comp).toContain("aria-label={searchLabel}");
    expect(comp).toContain("aria-pressed={kind === k.id}");
    expect(comp).toContain('aria-label="검색어 지우기"');
    expect(comp).toContain('query !== "" && (');
  });
  it("iOS 자동 확대 방지 16px, 그룹 chip은 가로 스크롤 한 줄(페이지 overflow 없음), 긴 라벨 ellipsis", () => {
    const block = css.slice(css.indexOf(".catalog-search-input"));
    expect(block).toContain("font-size: 16px");
    expect(css).toMatch(/\.catalog-chips \{[^}]*overflow-x: auto[^}]*max-width: 100%/);
    expect(css).toMatch(/\.catalog-chips \.filter-chip \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/);
  });
  it("sticky는 sheet 안에서 상단 고정(title/handle 아래), 서버 요청 없음", () => {
    expect(css).toContain(".catalog-filter.is-sticky { position: sticky; top: 0;");
    expect(comp).not.toMatch(/fetch\(|supabase/);
  });
});
