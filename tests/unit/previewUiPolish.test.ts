/*
  Preview QA UI 보정(2026-10-02): 가격 채우기 정렬, 판매 최대 횟수 문구, 수강권 카드 정보/액션 분리, 그룹 필터 chip.
  UI-only(DB/RPC/로직 변경 없음) — 회귀가 중요한 구조만 소스/CSS 계약으로 검증한다. 실제 320~430px 렌더링은 브라우저가 필요해 CSS 구조로만 확인.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const editor = read("app/components/CountPriceEditor.tsx");
const css = read("app/globals.css");
const page = read("app/manager/membership-rules/page.tsx");
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("판매 최대 횟수 문구", () => {
  it("'회'와 '최대 100회'만 보이고 '1회 ~ N회' 설명은 없다(상한 로직은 MAX_TIER_COUNT 그대로)", () => {
    const code = stripTs(editor);
    expect(code).toContain('<span className="count-price-max-unit">회</span>');
    expect(code).toContain("최대 {MAX_TIER_COUNT}회");
    expect(code).not.toMatch(/\(1회 ~|1회 ~ \{rowMax\}회/);
    expect(read("lib/goodsForm.ts")).toContain("export const MAX_TIER_COUNT = 100;");
  });
  it("좁은 화면에서는 문구가 자연스럽게 줄바꿈(flex-wrap)된다", () => {
    expect(css).toMatch(/\.count-price-max \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.count-price-max-cap \{[^}]*white-space: nowrap/);
  });
});

describe("가격 채우기 정렬", () => {
  it("입력과 버튼의 높이가 같고(44px) 같은 중앙선, 버튼은 한 줄·필요한 만큼만, 입력이 남는 공간 사용", () => {
    expect(css).toMatch(/\.count-price-fill \{[^}]*align-items: center/);
    expect(css).toMatch(/\.count-price-fill \.input-field \{[^}]*flex: 1 1 0[^}]*height: 44px/);
    expect(css).toMatch(/\.count-price-fill \.ghost-btn\.count-price-fill-btn \{[^}]*flex: 0 0 auto[^}]*width: auto[^}]*height: 44px[^}]*white-space: nowrap/);
  });
  it("좁은 모바일은 세로 배치, 컨테이너 밖으로 나가지 않는다(min-width:0/max-width:100%)", () => {
    expect(css).toMatch(/@media \(max-width: 420px\) \{\s*\.count-price-fill \{ flex-direction: column/);
    expect(css).toMatch(/\.count-price-fill \{[^}]*min-width: 0; max-width: 100%/);
  });
});

describe("수강권 카드(/manager/membership-rules): 정보와 액션 분리", () => {
  const card = page.slice(page.indexOf('<div key={p.id} className="pass-card">'), page.indexOf('className="pass-rules-toggle"'));
  it("정보 영역(.pass-head/.pass-info)과 액션(.pass-actions)이 서로 다른 블록이며, 액션이 정보와 같은 flex 행에 없다", () => {
    expect(card).toContain('<div className="pass-info">');
    expect(card).toContain('<div className="pass-actions">');
    expect(card.indexOf('className="pass-info"')).toBeLessThan(card.indexOf('className="pass-actions"'));
    const head = card.slice(card.indexOf('<div className="pass-head">'), card.indexOf('<div className="pass-actions">'));
    expect(head).not.toContain("quiet-action");
    expect(css).toMatch(/\.pass-head \{ display: block; \}/);
  });
  it("제목은 독립 줄, badge는 별도 wrap 컨테이너, 가격 요약은 별도 줄", () => {
    expect(card).toContain('<div className="pass-name">{p.name}</div>');
    expect(card).toContain('<div className="pass-tags">');
    expect(card).toContain('<div className="pass-sub">');
    expect(card.indexOf('pass-name')).toBeLessThan(card.indexOf('pass-tags'));
    expect(card.indexOf('pass-tags')).toBeLessThan(card.indexOf('pass-sub'));
  });
  it("긴 텍스트: 제목/가격은 단어 단위로 wrap(한 글자씩 세로로 쪼개지 않음), badge 글자는 nowrap + badge 단위로 줄 이동", () => {
    expect(css).toMatch(/\.pass-info \.pass-name \{[^}]*overflow-wrap: anywhere; word-break: keep-all/);
    expect(css).toMatch(/\.pass-tags \{ display: flex; flex-wrap: wrap/);
    expect(css).toMatch(/\.pass-tags \.pass-group-tag \{[^}]*white-space: nowrap/);
    expect(css).toMatch(/\.pass-info \.pass-sub \{[^}]*word-break: keep-all/);
  });
  it("액션 버튼: 한 줄 균등 배치, 좁은 화면 2×2, nowrap, 순서·기능·권한 조건·danger 색 유지", () => {
    expect(css).toMatch(/\.pass-actions \.quiet-action \{[^}]*flex: 1 1 0[^}]*white-space: nowrap/);
    expect(css).toMatch(/@media \(max-width: 420px\) \{\s*\.pass-actions \.quiet-action \{ flex: 1 1 calc\(50% - 6px\)/);
    const a = card.slice(card.indexOf('<div className="pass-actions">'));
    expect(a.indexOf("handleToggleSale(p)")).toBeLessThan(a.indexOf("openEditSheet(p)"));
    expect(a.indexOf("openEditSheet(p)")).toBeLessThan(a.indexOf("openDuplicateSheet(p)"));
    expect(a.indexOf("openDuplicateSheet(p)")).toBeLessThan(a.indexOf("handleDeleteProduct(p)"));
    expect(card).toContain("(canEditRules || canToggleSale) && (");
    expect(card).toContain("canToggleSale && (");
    expect(card).toContain("canCreateProduct && (");
    expect(card).toContain('className="quiet-action danger"');
    expect(card).toContain('{p.isOnSale ? "판매정지" : "판매재개"}');
  });
  it("예약 조건 영역/예약조건 추가는 그대로", () => {
    expect(page).toContain('className="pass-rules-toggle"');
    expect(page).toContain("예약 조건 {rules.length}개");
    expect(page).toContain('className="prog-add-sub-btn"');
  });
});

describe("그룹 필터 chip 디자인", () => {
  it("manager 화면의 CatalogSearchFilter chip은 밑줄 탭이 아니라 pill(border 1px + radius 999px), 선택은 accent", () => {
    expect(css).toMatch(/\.manager-v3-content \.catalog-chips \.filter-chip \{[^}]*border: 1px solid var\(--line\); border-radius: 999px/);
    expect(css).toMatch(/\.manager-v3-content \.catalog-chips \.filter-chip\.on \{[^}]*border-color: var\(--accent\)/);
    expect(css).not.toMatch(/\.catalog-chips[^{]*\{[^}]*border-bottom: 2px/);
  });
  it("manager 전용으로 한정(.manager-v3-content) — 회원 구매 sheet 등 다른 화면의 기본 pill/공용 컴포넌트는 변경 없음", () => {
    const comp = read("app/components/CatalogSearchFilter.tsx");
    expect(comp).toContain('className={`filter-chip ${kind === k.id ? "on" : ""}`}');
    expect(css).toMatch(/\.catalog-chips \.filter-chip \{ flex: 0 0 auto; white-space: nowrap; max-width: 70vw; overflow: hidden; text-overflow: ellipsis; \}/);
    // 공용 컴포넌트를 쓰는 화면
    for (const f of ["app/manager/membership-rules/page.tsx", "app/manager/goods/page.tsx", "app/center/[id]/page.tsx"]) {
      expect(read(f)).toContain("CatalogSearchFilter");
    }
  });
  it("chip 줄은 내부 가로 스크롤(페이지 overflow 없음), 긴 라벨은 한 줄", () => {
    expect(css).toMatch(/\.catalog-chips \{[^}]*overflow-x: auto[^}]*max-width: 100%/);
  });
});
