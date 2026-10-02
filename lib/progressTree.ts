/*
  진도 분류/기술 트리(2026-10-03) — 행의 의미는 node_type으로 명시한다('category' | 'skill'). 자식이 있는지로 추론하지 않는다.
  · category: 최상위이거나 category 아래. 분류 깊이는 최대 7단계(기술은 깊이에 포함하지 않는다).
  · skill: 반드시 category 아래의 말단. 진도 기록은 skill에만 한다. 분류↔기술 전환은 없다.
  이 파일은 순수 함수만 담는다. 서버 쪽 최종 방어선(유형/순환/깊이/센터 일치/기록은 skill만)은 fix_progress_category_tree_20261003.sql 트리거가 맡는다.
*/
export const MAX_PROGRESS_DEPTH = 7;   // 분류 단계 수

export type NodeType = "category" | "skill";
export type FlatCategory = { id: string; parentId: string | null; name: string; sortOrder: number; nodeType: NodeType };
// depth: 화면 들여쓰기 단계(분류=분류 깊이, 기술=부모 분류 깊이 + 1). catDepth: 이 노드가(분류라면 자신, 기술이라면 소속 분류가) 몇 번째 분류 단계인지.
export type TreeNode = FlatCategory & { depth: number; catDepth: number; children: TreeNode[] };

// 평면 목록 → 트리. 부모가 없거나(고아)/순환에 걸린/기술 아래에 달린 항목은 최상위로 올려 화면에서 사라지지 않게 한다. 형제는 sortOrder → 이름 순.
export function buildTree(cats: FlatCategory[]): TreeNode[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const kids = new Map<string | null, FlatCategory[]>();
  const rootOf = (c: FlatCategory): string | null => {
    let cur: FlatCategory | undefined = c; const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      if (!cur.parentId) return null;
      if (seen.has(cur.id)) return "cycle";
      seen.add(cur.id);
      const p = byId.get(cur.parentId);
      if (!p || p.nodeType === "skill") return "orphan";
      cur = p;
    }
    return "cycle";
  };
  for (const c of cats) {
    const r = rootOf(c);
    const key = c.parentId && byId.has(c.parentId) && r === null ? c.parentId : null;
    (kids.get(key) ?? kids.set(key, []).get(key)!).push(c);
  }
  const sort = (xs: FlatCategory[]) => [...xs].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"));
  const make = (c: FlatCategory, depth: number, catDepth: number): TreeNode => ({
    ...c, depth, catDepth,
    children: c.nodeType === "category" ? sort(kids.get(c.id) ?? []).map((k) => make(k, depth + 1, k.nodeType === "category" ? catDepth + 1 : catDepth)) : [],
  });
  return sort(kids.get(null) ?? []).map((t) => make(t, 1, 1));
}

export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}

export const isCategory = (n: Pick<FlatCategory, "nodeType">): boolean => n.nodeType === "category";

// 이 노드를 루트로 한 부분 트리의 "분류" 높이(자기 자신이 분류면 1, 기술은 0)
export function categoryHeight(node: TreeNode): number {
  if (node.nodeType !== "category") return 0;
  return 1 + Math.max(0, ...node.children.map(categoryHeight));
}

export function countDescendants(node: TreeNode): number {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

// 하위 분류를 더 만들 수 있는가: 분류이고 현재 분류 단계 < 7
export function canAddSubCategory(node: Pick<TreeNode, "nodeType" | "catDepth">): boolean {
  return node.nodeType === "category" && node.catDepth < MAX_PROGRESS_DEPTH;
}
// 기술은 어떤 분류 아래에도(7단계 분류 아래에도) 만들 수 있다. 기술 아래에는 아무것도 만들 수 없다.
export function canAddSkill(node: Pick<TreeNode, "nodeType">): boolean {
  return node.nodeType === "category";
}

// 새 항목/이동의 부모 검증(클라이언트 사전 검사 — 서버 트리거가 최종 강제).
export type MoveCheck = { ok: true } | { ok: false; reason: "self" | "cycle" | "depth" | "other_center" | "parent_is_skill" | "skill_needs_parent" | "parent_missing" };
export function checkParentChange(
  nodeId: string | null, newParentId: string | null, flat: FlatCategory[],
  opts?: { nodeType?: NodeType; newSubtreeCategoryHeight?: number; sameCenter?: boolean },
): MoveCheck {
  const nodeType = opts?.nodeType ?? "category";
  if (opts?.sameCenter === false) return { ok: false, reason: "other_center" };
  if (!newParentId) return nodeType === "skill" ? { ok: false, reason: "skill_needs_parent" } : { ok: true };
  if (nodeId && nodeId === newParentId) return { ok: false, reason: "self" };
  const byId = new Map(flat.map((c) => [c.id, c]));
  const parent = byId.get(newParentId);
  if (parent && parent.nodeType === "skill") return { ok: false, reason: "parent_is_skill" };
  // 새 부모의 조상 체인에 node가 있으면 순환, 체인 길이 = 부모의 분류 깊이
  let depth = 0; let cur: FlatCategory | undefined = parent; const seen = new Set<string>();
  while (cur) {
    if (nodeId && cur.id === nodeId) return { ok: false, reason: "cycle" };
    if (seen.has(cur.id)) return { ok: false, reason: "cycle" };
    seen.add(cur.id); depth++;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  if (nodeType === "category") {
    const height = opts?.newSubtreeCategoryHeight ?? 1;
    if (depth + height > MAX_PROGRESS_DEPTH) return { ok: false, reason: "depth" };
  }
  return { ok: true };
}

export function categoryPath(id: string, flat: FlatCategory[]): string[] {
  const byId = new Map(flat.map((c) => [c.id, c]));
  const out: string[] = []; let cur = byId.get(id); const seen = new Set<string>();
  while (cur && !seen.has(cur.id) && out.length < MAX_PROGRESS_DEPTH + 2) { out.unshift(cur.name); seen.add(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
  return out;
}

// 기록 화면에서 선택할 수 있는 것 = node_type='skill'만. 그룹 제목은 소속 분류의 경로. 기술이 없는 분류는 어떤 형태로도 기술처럼 보이지 않는다(그룹을 만들지 않는다).
export type SkillGroup = { path: string[]; skills: TreeNode[] };
export function skillGroups(roots: TreeNode[]): { groups: SkillGroup[] } {
  const groups: SkillGroup[] = [];
  const walk = (n: TreeNode, path: string[]) => {
    if (n.nodeType !== "category") return;
    const here = [...path, n.name];
    const skills = n.children.filter((c) => c.nodeType === "skill");
    if (skills.length) groups.push({ path: here, skills });
    for (const c of n.children) if (c.nodeType === "category") walk(c, here);
  };
  for (const t of roots) walk(t, []);
  return { groups };
}

// 들여쓰기 상한: 좁은 화면에서 폭이 사라지지 않게 4단계까지만 실제로 들여쓰고 이후는 같은 들여쓰기 + 깊이 표시(Lv N)로 구분한다.
export const MAX_VISUAL_INDENT_LEVELS = 4;
export function indentLevel(depth: number): number { return Math.min(Math.max(depth - 1, 0), MAX_VISUAL_INDENT_LEVELS); }
