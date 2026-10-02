import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dayDisplayKey, groupRulesByDay, sortRulesForDisplay, summarizeRules, toggleExpanded } from "../../lib/ruleDisplay";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
let n = 0;
const r = (dayOfWeek: number | null, startTime: string | null, classTitle: string | null = null, id = `r${++n}`) => ({ id, dayOfWeek, startTime, classTitle });

describe("예약조건 정렬(월→일, DB 0=일)", () => {
  it("일/월/금/화 → 월/화/금/일", () => {
    expect(sortRulesForDisplay([r(0, "10:00"), r(1, "10:00"), r(5, "10:00"), r(2, "10:00")]).map((x) => x.dayOfWeek)).toEqual([1, 2, 5, 0]);
    expect([1, 2, 3, 4, 5, 6, 0].map(dayDisplayKey)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("같은 요일은 시작 시각 오름차순", () => {
    expect(sortRulesForDisplay([r(1, "20:00"), r(1, "09:30"), r(1, "14:00")]).map((x) => x.startTime)).toEqual(["09:30", "14:00", "20:00"]);
  });
  it("같은 요일+시각은 수업명 가나다, 그다음 id로 안정", () => {
    const out = sortRulesForDisplay([r(1, "19:00", "정규반", "b"), r(1, "19:00", "고급반", "c"), r(1, "19:00", "고급반", "a")]);
    expect(out.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });
  it("day_of_week=null(모든 요일)은 별도 그룹으로 맨 앞", () => {
    const g = groupRulesByDay([r(0, "10:00"), r(null, "08:00"), r(1, "09:00")]);
    expect(g.map((x) => x.label)).toEqual(["모든 요일", "월요일", "일요일"]);
  });
  it("start_time=null(모든 시간)은 해당 요일 맨 위", () => {
    const g = groupRulesByDay([r(2, "09:00", "A"), r(2, null, "B"), r(2, "07:00", "C")]);
    expect(g[0].rows.map((x) => x.time)).toEqual(["모든 시간", "07:00", "09:00"]);
  });
  it("빈 조건 / 1개 / 여러 개, 입력 배열 불변, 한 조건 = 한 row", () => {
    expect(groupRulesByDay([])).toEqual([]);
    expect(summarizeRules([])).toBeNull();
    const one = [r(3, "19:40", "어텐션 개인안무&승급준비반")];
    expect(groupRulesByDay(one)).toEqual([{ dayOfWeek: 3, label: "수요일", rows: [{ id: one[0].id, time: "19:40", title: "어텐션 개인안무&승급준비반" }] }]);
    const many = [r(0, "07:10"), r(5, "19:40"), r(6, "16:30"), r(1, "20:00"), r(2, "20:00"), r(3, "20:30")];
    const copy = [...many];
    expect(groupRulesByDay(many).flatMap((x) => x.rows)).toHaveLength(6);
    expect(many).toEqual(copy);
  });
  it("summary: 개수 + 요일 범위(1줄), 조건 전문을 이어붙이지 않는다", () => {
    const all = [0, 1, 2, 3, 4, 5, 6].map((d) => r(d, "10:00", "아주 긴 수업 이름"));
    expect(summarizeRules(all)).toBe("예약조건 7개 · 월~일");
    expect(summarizeRules([r(1, "10:00"), r(3, "10:00"), r(3, "11:00")])).toBe("예약조건 3개 · 월·수");
    expect(summarizeRules([r(null, null)])).toBe("예약조건 1개 · 모든 요일");
    expect(summarizeRules(all)).not.toContain("아주 긴");
  });
});

describe("accordion 상태(상품별 독립)", () => {
  it("기본 collapsed → 펼침 → 다시 접힘, 다른 상품 영향 없음", () => {
    let open = new Set<string>();
    expect(open.has("a")).toBe(false);
    open = toggleExpanded(open, "a");
    expect([open.has("a"), open.has("b")]).toEqual([true, false]);
    open = toggleExpanded(open, "b");
    open = toggleExpanded(open, "a");
    expect([open.has("a"), open.has("b")]).toEqual([false, true]);
  });
  it("컴포넌트: 기본 닫힘, aria-expanded/controls, 조건 0개면 렌더 없음, 토글은 전용 버튼", () => {
    const c = read("app/components/ProductRuleAccordion.tsx");
    expect(c).toContain("useState(false)");
    expect(c).toContain("aria-expanded={open}");
    expect(c).toContain("aria-controls={panelId}");
    expect(c).toContain("if (!rules || rules.length === 0) return null;");
  });
});

describe("구매 sheet 통합 계약", () => {
  const page = read("app/center/[id]/page.tsx");
  it("예약조건을 ' / '로 이어붙이지 않고 accordion을 카드 안(버튼 뒤)에 둔다 — 기존 구매 control 유지", () => {
    expect(page).not.toContain('rules.map(ruleToText).join(" / ")');
    expect(page).toContain("<ProductRuleAccordion rules={rules} />");
    for (const k of ['onAddCart(p, sel)', 'onBuy(p, sel)', "isCountSelectable(p)", "구매 횟수", "<CatalogSearchFilter", "nextFilterOnKind"]) expect(page).toContain(k);
  });
  it("검색/필터 띠 원인 수정: sheet 안에서는 sheet 바탕(--bg), chip 행은 같은 규격", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.sheet \.catalog-filter \{[^}]*background: var\(--bg\)/);
    expect(css).toMatch(/\.sheet \.catalog-chips \.filter-chip \{[^}]*height: 36px; padding: 0 14px/);
    expect(css).toMatch(/\.sheet \.catalog-chips \{[^}]*flex-wrap: wrap/);
  });
  it("결제/PG 코드는 건드리지 않았다", () => {
    expect(page).toContain("handlePurchase");
  });
});
