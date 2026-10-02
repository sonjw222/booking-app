/* 진도 분류(category)/기술(skill) 명시 모델 — 순수 helper + 화면/lib/SQL 계약(DB 동작은 tests/sql/progress-category-tree.test.mjs) */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

const inserts: any[] = [];
let failCode: string | null = null;
let rows: any[] = [];
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (_t: string) => {
      let selected = "";
      let insertedRow: any = undefined;
      const chain: any = {
        select(columns?: string) { selected = columns ?? ""; return chain; }, eq() { return chain; }, order() { return chain; }, in() { return chain; },
        insert(row: any) { insertedRow = row; inserts.push(row); return chain; },
        then(res: any) {
          const nodeTypeAccess =
            insertedRow ? "node_type" in insertedRow : selected.includes("node_type");
          if (failCode && nodeTypeAccess) return Promise.resolve({ data: null, error: { code: failCode, message: "no node_type" } }).then(res);
          return Promise.resolve({ data: rows, error: null }).then(res);
        },
      };
      return chain;
    },
  },
}));
vi.mock("../../lib/authAccount", () => ({ getMyAccountId: async () => "acc" }));
import { buildTree, canAddSkill, canAddSubCategory, categoryHeight, checkParentChange, flattenTree, indentLevel, MAX_PROGRESS_DEPTH, skillGroups, type FlatCategory } from "../../lib/progressTree";
import { addSkill, addSubCategory, addTopCategory, fetchCategories } from "../../lib/progress";

const C = (id: string, parentId: string | null, name = id, sortOrder = 0): FlatCategory => ({ id, parentId, name, sortOrder, nodeType: "category" });
const S = (id: string, parentId: string | null, name = id, sortOrder = 0): FlatCategory => ({ id, parentId, name, sortOrder, nodeType: "skill" });

describe("tree: category/skill은 node_type으로만 구분(자식 유무로 추론하지 않는다)", () => {
  it("기존 2단계(분류 + 기술) 그대로, 기술이 없는 분류는 기술로 보이지 않는다", () => {
    const flat = [C("top", null, "점프"), S("s1", "top", "왈츠", 0), S("s2", "top", "살코", 1), C("empty", null, "스핀")];
    const g = skillGroups(buildTree(flat));
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0].path).toEqual(["점프"]);
    expect(g.groups[0].skills.map((s) => s.name)).toEqual(["왈츠", "살코"]);
    expect(JSON.stringify(g)).not.toContain("스핀");   // 빈 분류는 어떤 형태로도 기술처럼 나오지 않는다
  });
  it("자식이 없는 분류가 skill이 되지 않고, 기술에 자식이 생겨 분류로 바뀌지도 않는다", () => {
    const t = buildTree([C("a", null), C("b", "a"), S("k", "b")]);
    const all = flattenTree(t);
    expect(all.find((n) => n.id === "b")!.nodeType).toBe("category");
    expect(all.find((n) => n.id === "k")!.nodeType).toBe("skill");
    expect(skillGroups(t).groups.map((g) => g.skills.map((s) => s.id))).toEqual([["k"]]);   // 빈 분류 a는 제외, b 아래 기술 k만
  });
  it("하나의 분류 아래 하위 분류와 기술이 동시에 존재, 기술 그룹 제목은 소속 분류 경로", () => {
    const flat = [C("1", null, "점프"), C("2", "1", "싱글 점프"), C("3", "2", "엣지 점프"), S("4", "3", "왈츠", 0), S("5", "3", "살코", 1), S("6", "1", "기본기")];
    const g = skillGroups(buildTree(flat)).groups;
    expect(g.map((x) => x.path.join(" › "))).toEqual(["점프", "점프 › 싱글 점프 › 엣지 점프"]);
    expect(g[1].skills.map((s) => s.name)).toEqual(["왈츠", "살코"]);
  });
  it("분류 깊이 1~7 허용, 8번째 분류 거부, 7단계 분류 아래에도 기술 가능(기술은 깊이에 포함하지 않는다)", () => {
    const chain = Array.from({ length: 7 }, (_, i) => C(String(i + 1), i === 0 ? null : String(i)));
    const t = buildTree([...chain, S("k", "7")]);
    const nodes = flattenTree(t);
    expect(nodes.filter((n) => n.nodeType === "category").map((n) => n.catDepth)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const seven = nodes.find((n) => n.id === "7")!;
    expect(canAddSubCategory(seven)).toBe(false);
    expect(canAddSkill(seven)).toBe(true);
    expect(canAddSubCategory(nodes.find((n) => n.id === "6")!)).toBe(true);
    expect(nodes.find((n) => n.id === "k")!.catDepth).toBe(7);
    expect(canAddSkill(nodes.find((n) => n.id === "k")!)).toBe(false);          // 기술 아래에는 아무것도 못 만든다
    expect(canAddSubCategory(nodes.find((n) => n.id === "k")!)).toBe(false);
    const flat = [...chain, S("k", "7")];
    expect(checkParentChange(null, "6", flat, { nodeType: "category" })).toEqual({ ok: true });
    expect(checkParentChange(null, "7", flat, { nodeType: "category" })).toEqual({ ok: false, reason: "depth" });
    expect(checkParentChange(null, "7", flat, { nodeType: "skill" })).toEqual({ ok: true });
    expect(MAX_PROGRESS_DEPTH).toBe(7);
  });
  it("기술 규칙: top-level 기술 불가, 기술 아래 자식 불가, cycle/self 거부, 이동 시 분류 높이만 계산", () => {
    const flat = [C("1", null), C("2", "1"), C("3", "2"), S("k", "3")];
    expect(checkParentChange(null, null, flat, { nodeType: "skill" })).toEqual({ ok: false, reason: "skill_needs_parent" });
    expect(checkParentChange(null, "k", flat, { nodeType: "category" })).toEqual({ ok: false, reason: "parent_is_skill" });
    expect(checkParentChange(null, "k", flat, { nodeType: "skill" })).toEqual({ ok: false, reason: "parent_is_skill" });
    expect(checkParentChange("1", "1", flat)).toEqual({ ok: false, reason: "self" });
    expect(checkParentChange("1", "3", flat)).toEqual({ ok: false, reason: "cycle" });
    expect(checkParentChange("x", "3", flat, { newSubtreeCategoryHeight: 5 })).toEqual({ ok: false, reason: "depth" });
    expect(checkParentChange(null, "3", flat, { sameCenter: false })).toEqual({ ok: false, reason: "other_center" });
    expect(categoryHeight(buildTree(flat)[0])).toBe(3);   // 기술 k는 높이에 포함하지 않는다
  });
  it("고아/순환/기술 아래 매달린 데이터도 사라지지 않고 최상위로 올라온다, 들여쓰기는 4단계 상한", () => {
    const t = buildTree([C("a", "zzz", "고아"), C("b", "c", "순환1"), C("c", "b", "순환2"), S("k", null, "기술"), C("d", "k", "기술아래")]);
    expect(t.map((n) => n.name).sort()).toEqual(["고아", "기술", "기술아래", "순환1", "순환2"].sort());
    expect([1, 2, 5, 6, 7, 8].map(indentLevel)).toEqual([0, 1, 4, 4, 4, 4]);
  });
});

describe("lib/progress: 명시적 node_type 저장 + SQL 미적용 DB 호환", () => {
  beforeEach(() => { inserts.length = 0; failCode = null; rows = []; });
  it("분류/하위 분류/기술은 항상 node_type을 명시해 저장한다", async () => {
    rows = [{ id: "p", parent_id: null, name: "점프", sort_order: 0, node_type: "category" }];
    await addTopCategory("c1", "점프", 0);
    await addSubCategory("c1", "p", "싱글", 0);
    await addSkill("c1", "p", "왈츠", 0);
    expect(inserts.map((r) => [r.parent_id, r.node_type])).toEqual([[null, "category"], ["p", "category"], ["p", "skill"]]);
  });
  it("분류 7단계 아래에는 하위 분류 추가를 미리 거부하지만 기술은 추가된다", async () => {
    rows = Array.from({ length: 7 }, (_, i) => ({ id: `n${i + 1}`, parent_id: i === 0 ? null : `n${i}`, name: `n${i + 1}`, sort_order: 0, node_type: "category" }));
    await expect(addSubCategory("c1", "n7", "x", 0)).rejects.toThrow("최대 7단계");
    await addSkill("c1", "n7", "왈츠", 0);
    expect(inserts.at(-1)).toMatchObject({ parent_id: "n7", node_type: "skill" });
  });
  it("기술 아래 추가/기술을 top-level로 만드는 시도는 클라이언트에서도 거부", async () => {
    rows = [{ id: "c", parent_id: null, name: "c", sort_order: 0, node_type: "category" }, { id: "k", parent_id: "c", name: "k", sort_order: 0, node_type: "skill" }];
    await expect(addSkill("c1", "k", "x", 0)).rejects.toThrow("기술 아래에는");
    await expect(addSubCategory("c1", "k", "x", 0)).rejects.toThrow("기술 아래에는");
  });
  it("SQL 미적용(node_type 컬럼 없음 42703) DB에서는 옛 구조로 읽고(top=분류/하위=기술), 1~2단계 추가만 node_type 없이 허용, 하위 분류는 안내", async () => {
    failCode = "42703";
    rows = [{ id: "p", parent_id: null, name: "점프", sort_order: 0 }, { id: "s", parent_id: "p", name: "왈츠", sort_order: 0 }];
    const cats = await fetchCategories("c1");
    expect(cats.map((c) => c.nodeType)).toEqual(["category", "skill"]);
    await addSkill("c1", "p", "살코", 1);
    expect(inserts.at(-1)).not.toHaveProperty("node_type");
    await expect(addSubCategory("c1", "p", "싱글", 0)).rejects.toThrow("진도 분류 SQL");
  });
});

describe("화면/SQL 계약", () => {
  const page = read("app/manager/progress/page.tsx");
  it("관리 화면: generic '하위 분류 또는 기술' 입력 제거, [하위 분류 추가]/[기술 추가] 분리, 분류만 chevron(accordion), 기술은 chevron 없음", () => {
    expect(page).not.toContain("하위 분류 또는 기술 이름");
    expect(page).toContain("하위 분류 추가</button>");
    expect(page).toContain("기술 추가</button>");
    expect(page).toContain("await addSubCategory(centerId, parent.id, name,");
    expect(page).toContain("await addSkill(centerId, parent.id, name,");
    expect(page).toContain("aria-expanded={open}");
    expect(page).toContain("aria-controls={panelId}");
    const skillRow = page.slice(page.indexOf('if (node.nodeType === "skill") {'), page.indexOf("const hasKids"));
    expect(skillRow).not.toContain("ptree-toggle");
    expect(skillRow).not.toContain("aria-expanded");
  });
  it("관리 화면: 7단계 분류는 '하위 분류 추가' 비활성 + 안내, 기술 추가는 계속 가능, 입력값은 접어도 유지, 수정/삭제는 분류·기술 모두", () => {
    expect(page).toContain("canAddSubCategory(node) ? (");
    expect(page).toContain("분류는 최대 {MAX_PROGRESS_DEPTH}단계라 하위 분류를 더 만들 수 없어요");
    expect(page).toContain('<button className="outline-action" disabled>하위 분류 추가</button>');
    expect(page).toContain("skillInput[node.id]");
    expect(page).toContain("subInput[node.id]");
    expect(page).toContain("입력 중");
    expect(page.match(/handleRename\(node\.id, node\.name\)/g)).toHaveLength(2);
    expect(page.match(/handleDelete\(node\.id, node\.name,/g)).toHaveLength(2);
    expect(page).not.toMatch(/node_type|nodeType\s*=\s*["']/);   // node_type 변경 UI 없음
  });
  it("기록 화면: skill 그룹만 선택(emptyTops/빈 분류 표시 제거), 기술이 없으면 안내", () => {
    const rec = read("app/manager/progress/record/page.tsx");
    expect(rec).not.toContain("emptyTops");
    expect(rec).not.toContain("세부기술 없음");
    expect(rec).toContain("기록할 기술이 없어요");
    expect(rec).toContain("skillGroups(tree)");
  });
  it("삭제: 하위 전체(분류 7단계 + 기술)에 기록이 있으면 아무것도 지우지 않고 거부, 가장 깊은 것부터 삭제", () => {
    const lib = read("lib/progress.ts");
    expect(lib).toContain("level < MAX_PROGRESS_DEPTH + 1");
    expect(lib).toContain("진도 기록이 있는 기술이 포함돼 있어 삭제할 수 없어요");
    expect(lib).toContain("[...ids].reverse()");
  });
  it("migration SQL 계약: node_type 컬럼/제약/backfill, 기술 규칙, 분류 깊이 기준, 기록 가드, 중단 가드, 동시성 lock", () => {
    const sql = read("fix_progress_category_tree_20261003.sql").replace(/--.*$/gm, "");
    for (const x of [
      "add column if not exists node_type text",
      "set node_type = case when parent_id is null then 'category' else 'skill' end where node_type is null",
      "check (node_type in ('category', 'skill'))",
      "check (node_type = 'category' or parent_id is not null)",
      "기술 아래에는 분류나 기술을 만들 수 없어요",
      "분류와 기술은 서로 바꿀 수 없어요",
      "분류는 최대 7단계까지 만들 수 있어요",
      "where parent_id = new.id and node_type = 'category'",
      "분류에는 진도를 기록할 수 없어요",
      "before insert or update of category_id on public.progress_records",
      "pg_advisory_xact_lock(hashtextextended('progress_categories_tree:' || new.center_id::text, 0))",
    ]) expect(sql).toContain(x);
    expect(sql).toMatch(/begin;[\s\S]*commit;/);
    const rb = read("rollback_fix_progress_category_tree_20261003.sql").replace(/--.*$/gm, "");
    expect(rb).toContain("drop column if exists node_type");
    expect(rb).not.toMatch(/delete from|drop table|truncate/i);
  });
  it("정렬 CSS(기존): 14px 기준선, 입력창+추가 버튼 같은 높이(48px), 들여쓰기 누적 없음", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.ptree-row \{[^}]*padding:6px 14px/);
    expect(css).toMatch(/\.ptree-add \.input-field, \.ptree-add \.outline-action \{[^}]*height:48px/);
    expect(css).not.toMatch(/\.ptree-panel \{[^}]*margin-left/);
  });
});
