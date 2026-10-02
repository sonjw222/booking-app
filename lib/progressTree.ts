/*
  진도 분류 트리(2026-10-03) — 분류(category)를 최대 7단계까지 중첩하고, 기술(skill)은 분류 아래 말단 항목이다.
  DB는 이미 progress_categories.parent_id(self FK)를 갖고 있어 새 컬럼 없이 같은 테이블을 계층으로 쓴다(기존 1~2단계 데이터는 그대로 호환).
  이 파일은 순수 함수만 담는다: 트리 구성/깊이/경로/검증. 서버 쪽 최종 방어선(순환·깊이·센터 일치)은 fix_progress_category_tree_20261003.sql 트리거가 맡는다.
*/
export const MAX_PROGRESS_DEPTH = 7;

export type FlatCategory = { id: string; parentId: string | null; name: string; sortOrder: number };
export type TreeNode = FlatCategory & { depth: number; children: TreeNode[] };

// 평면 목록 → 트리. 부모가 없거나(고아) 순환에 걸린 항목은 최상위로 올려 화면에서 사라지지 않게 한다. 형제는 sortOrder → 이름 순.
export function buildTree(cats: FlatCategory[]): TreeNode[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const kids = new Map<string | null, FlatCategory[]>();
  const rootOf = (c: FlatCategory): string | null => {
    // 부모 체인을 따라가 순환/고아를 감지한다(최대 길이 제한)
    let cur: FlatCategory | undefined = c; const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      if (!cur.parentId) return null;
      if (seen.has(cur.id)) return "cycle";
      seen.add(cur.id);
      const p = byId.get(cur.parentId);
      if (!p) return "orphan";
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
  const make = (c: FlatCategory, depth: number): TreeNode => ({ ...c, depth, children: sort(kids.get(c.id) ?? []).map((k) => make(k, depth + 1)) });
  return sort(kids.get(null) ?? []).map((t) => make(t, 1));
}

export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}

// 이 노드를 루트로 한 부분 트리의 높이(자기 자신 = 1)
export function subtreeHeight(node: TreeNode): number {
  return 1 + (node.children.length ? Math.max(...node.children.map(subtreeHeight)) : 0);
}

export function countDescendants(node: TreeNode): number {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

// 하위 항목을 더 추가할 수 있는가(현재 깊이 < 7)
export function canAddChild(node: Pick<TreeNode, "depth">): boolean {
  return node.depth < MAX_PROGRESS_DEPTH;
}

// parent 아래로 node를 옮기거나 새로 만들 때의 검증(클라이언트 사전 검사 — 서버 트리거가 최종 강제).
export type MoveCheck = { ok: true } | { ok: false; reason: "self" | "cycle" | "depth" | "other_center" };
export function checkParentChange(
  nodeId: string | null, newParentId: string | null, flat: FlatCategory[], opts?: { newSubtreeHeight?: number; sameCenter?: boolean },
): MoveCheck {
  if (opts?.sameCenter === false) return { ok: false, reason: "other_center" };
  if (!newParentId) return { ok: true };
  if (nodeId && nodeId === newParentId) return { ok: false, reason: "self" };
  const byId = new Map(flat.map((c) => [c.id, c]));
  // 새 부모의 조상 체인에 node가 있으면 순환
  let depth = 0; let cur: FlatCategory | undefined = byId.get(newParentId); const seen = new Set<string>();
  while (cur) {
    if (nodeId && cur.id === nodeId) return { ok: false, reason: "cycle" };
    if (seen.has(cur.id)) return { ok: false, reason: "cycle" };
    seen.add(cur.id); depth++;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  const height = opts?.newSubtreeHeight ?? 1;
  if (depth + height > MAX_PROGRESS_DEPTH) return { ok: false, reason: "depth" };
  return { ok: true };
}

export function categoryPath(id: string, flat: FlatCategory[]): string[] {
  const byId = new Map(flat.map((c) => [c.id, c]));
  const out: string[] = []; let cur = byId.get(id); const seen = new Set<string>();
  while (cur && !seen.has(cur.id) && out.length < MAX_PROGRESS_DEPTH + 1) { out.unshift(cur.name); seen.add(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
  return out;
}

// 기록 화면에서 선택할 수 있는 기술 = 하위 항목이 없는 말단 중 최상위가 아닌 것(기존 2단계 동작과 동일). 그룹 제목은 부모 경로.
export type SkillGroup = { path: string[]; skills: TreeNode[] };
export function skillGroups(roots: TreeNode[]): { groups: SkillGroup[]; emptyTops: TreeNode[] } {
  const groups: SkillGroup[] = []; const emptyTops: TreeNode[] = [];
  const walk = (n: TreeNode, path: string[]) => {
    const here = [...path, n.name];
    const leaves = n.children.filter((c) => c.children.length === 0);
    if (leaves.length) groups.push({ path: here, skills: leaves });
    for (const c of n.children) if (c.children.length) walk(c, here);
  };
  for (const t of roots) { if (t.children.length === 0) emptyTops.push(t); else walk(t, []); }
  return { groups, emptyTops };
}

// 들여쓰기 상한: 좁은 화면에서 폭이 사라지지 않게 4단계까지만 실제로 들여쓰고 이후는 같은 들여쓰기 + 깊이 표시(Lv N)로 구분한다.
export const MAX_VISUAL_INDENT_LEVELS = 4;
export function indentLevel(depth: number): number { return Math.min(Math.max(depth - 1, 0), MAX_VISUAL_INDENT_LEVELS); }
