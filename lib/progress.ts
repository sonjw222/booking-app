/*
  진도표 - 카테고리(기술 목록) 관리
  - 센터마다 분류(category, 최대 7단계)와 기술(skill)로 구성 — 기술은 분류 아래 말단이고 진도 기록은 기술에만 한다
  - 예) 피겨: 점프 › 싱글 점프 › 엣지 점프 › 왈츠/살코, 스핀 › 카멜스핀 ...
*/

import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";
import { MAX_PROGRESS_DEPTH, checkParentChange } from "./progressTree";

import type { NodeType } from "./progressTree";

export type ProgressCategory = {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  nodeType: NodeType;
};

// 센터의 전체 항목(분류+기술, 평면). node_type 컬럼이 아직 없는 DB(SQL 미적용, 42703)에서는 옛 구조(최상위=분류, 그 아래=기술)로 읽는다 — 읽기 전용 호환일 뿐 새 화면의 의미 추론이 아니다.
export async function fetchCategories(centerId: string): Promise<ProgressCategory[]> {
  let res: { data: any[] | null; error: { code?: string; message: string } | null } = await supabase
    .from("progress_categories")
    .select("id, parent_id, name, sort_order, node_type")
    .eq("center_id", centerId)
    .order("sort_order");
  let legacy = false;
  if (res.error && res.error.code === "42703") {
    legacy = true;
    res = await supabase.from("progress_categories").select("id, parent_id, name, sort_order").eq("center_id", centerId).order("sort_order");
  }
  if (res.error) throw new Error("기술 목록을 불러오지 못했어요: " + res.error.message);
  return (res.data ?? []).map((c: any) => ({
    id: c.id, parentId: c.parent_id, name: c.name, sortOrder: c.sort_order,
    nodeType: (legacy ? (c.parent_id ? "skill" : "category") : c.node_type) as NodeType,
  }));
}

// 분류는 최대 7단계(기술은 깊이에 포함하지 않는다) — lib/progressTree.ts의 buildTree/checkParentChange.
export { buildTree, MAX_PROGRESS_DEPTH } from "./progressTree";

async function insertNode(row: { center_id: string; parent_id: string | null; name: string; sort_order: number; node_type: NodeType }): Promise<void> {
  const { error } = await supabase.from("progress_categories").insert(row);
  if (error && error.code === "42703") {
    // SQL 미적용 DB: 옛 구조로 표현 가능한 것(최상위 분류 / 최상위 분류 아래 기술)만 node_type 없이 허용한다.
    if (row.node_type === "category" && row.parent_id) throw new Error("하위 분류는 DB 업데이트(진도 분류 SQL) 적용 후 사용할 수 있어요");
    const { node_type: _t, ...legacy } = row;
    const retry = await supabase.from("progress_categories").insert(legacy);
    if (retry.error) throw new Error("추가에 실패했어요: " + retry.error.message);
    return;
  }
  if (error) throw new Error("추가에 실패했어요: " + error.message);
}

// 최상위 분류 추가
export async function addTopCategory(centerId: string, name: string, sortOrder: number): Promise<void> {
  await insertNode({ center_id: centerId, parent_id: null, name, sort_order: sortOrder, node_type: "category" });
}

// 하위 분류 추가 — 부모의 분류 깊이를 서버(트리거)와 별개로 미리 확인한다(분류 8단계 이상은 거부).
export async function addSubCategory(centerId: string, parentId: string, name: string, sortOrder: number): Promise<void> {
  const flat = await fetchCategories(centerId);
  const check = checkParentChange(null, parentId, flat, { nodeType: "category" });
  if (!check.ok) throw new Error(check.reason === "depth" ? `분류는 최대 ${MAX_PROGRESS_DEPTH}단계까지 만들 수 있어요` : check.reason === "parent_is_skill" ? "기술 아래에는 분류를 만들 수 없어요" : "이 분류 아래에는 추가할 수 없어요");
  await insertNode({ center_id: centerId, parent_id: parentId, name, sort_order: sortOrder, node_type: "category" });
}

// 기술 추가 — 반드시 분류 아래. 분류가 7단계여도 기술은 추가할 수 있다.
export async function addSkill(centerId: string, parentId: string, name: string, sortOrder: number): Promise<void> {
  const flat = await fetchCategories(centerId);
  const check = checkParentChange(null, parentId, flat, { nodeType: "skill" });
  if (!check.ok) throw new Error(check.reason === "parent_is_skill" ? "기술 아래에는 기술을 만들 수 없어요" : "이 분류 아래에는 기술을 추가할 수 없어요");
  await insertNode({ center_id: centerId, parent_id: parentId, name, sort_order: sortOrder, node_type: "skill" });
}

// 이름 수정
export async function renameCategory(id: string, name: string): Promise<void> {
  const { error } = await supabase
    .from("progress_categories")
    .update({ name })
    .eq("id", id);
  if (error) throw new Error("수정에 실패했어요: " + error.message);
}

// 삭제 — 분류면 하위 분류/기술 전체(최대 7단계 + 기술)를 가장 깊은 것부터 지운다. 하위 전체에 진도 기록이 하나라도 있으면 아무것도 지우지 않고 거부한다
// (기술 삭제도 같은 규칙: 기록이 있는 기술은 삭제 거부). 서버 FK(progress_records → progress_categories, on delete 없음)가 최종적으로 기록이 있는 행의 삭제를 막는다.
export async function deleteCategory(id: string): Promise<void> {
  const ids: string[] = [id];   // 얕은 것 → 깊은 것 순으로 쌓인다
  let frontier = [id];
  for (let level = 0; level < MAX_PROGRESS_DEPTH + 1 && frontier.length > 0; level++) {   // 분류 7단계 + 그 아래 기술 1단계
    const { data, error } = await supabase.from("progress_categories").select("id").in("parent_id", frontier);
    if (error) throw new Error("삭제에 실패했어요: " + error.message);
    frontier = (data ?? []).map((r: any) => r.id as string);
    ids.push(...frontier);
  }
  const { count } = await supabase.from("progress_records").select("id", { count: "exact", head: true }).in("category_id", ids);
  if ((count ?? 0) > 0) throw new Error("진도 기록이 있는 기술이 포함돼 있어 삭제할 수 없어요");
  for (const cid of [...ids].reverse()) {   // 가장 깊은 것부터
    const { error } = await supabase.from("progress_categories").delete().eq("id", cid);
    if (error) throw new Error("삭제에 실패했어요: " + error.message);
  }
}

/* ============================================================
   진도 기록 (progress_records) — 2단계
   - 강사가 회원별로 "오늘 가르친 기술"을 체크
   - 회원의 진도 이력 조회
   ============================================================ */

const KST_MD = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
});

// 진도 기록 한 건 (하루에 여러 기술)
export type ProgressRecord = {
  id: string;
  categoryId: string;
  skillName: string;
  parentName: string | null;   // 대분류 이름
  lessonDate: string;          // "2026-07-17"
  note: string | null;
  coachName: string | null;
};

// 회원의 진도 이력 (최근순)
export async function fetchMemberProgress(profileId: string): Promise<ProgressRecord[]> {
  const { data, error } = await supabase
    .from("progress_records")
    .select(`
      id, category_id, lesson_date, note,
      progress_categories(name, parent_id),
      accounts(name)
    `)
    .eq("profile_id", profileId)
    .order("lesson_date", { ascending: false })
    .limit(200);
  if (error) throw new Error("진도 이력을 불러오지 못했어요: " + error.message);

  const rows = data ?? [];
  // 대분류 이름을 채우기 위해 parent_id 모으기
  // 조상 경로(최대 7단계)를 단계별로 모아 "점프 › 싱글 점프"처럼 표시한다(기존 1단계 부모는 그대로 부모 이름 하나).
  const known: Record<string, { name: string; parentId: string | null }> = {};
  let need = Array.from(new Set(rows.map((r: any) => r.progress_categories?.parent_id).filter(Boolean))) as string[];
  for (let level = 0; level < MAX_PROGRESS_DEPTH && need.length > 0; level++) {
    const { data: parents } = await supabase.from("progress_categories").select("id, name, parent_id").in("id", need);
    const next: string[] = [];
    for (const p of parents ?? []) {
      known[(p as any).id] = { name: (p as any).name, parentId: (p as any).parent_id ?? null };
      const pp = (p as any).parent_id as string | null;
      if (pp && !known[pp]) next.push(pp);
    }
    need = Array.from(new Set(next));
  }
  const parentNames: Record<string, string> = {};
  for (const id of Object.keys(known)) {
    const names: string[] = []; let cur: string | null = id; const seen = new Set<string>();
    while (cur && known[cur] && !seen.has(cur)) { names.unshift(known[cur].name); seen.add(cur); cur = known[cur].parentId; }
    parentNames[id] = names.join(" › ");
  }

  return rows.map((r: any) => ({
    id: r.id,
    categoryId: r.category_id,
    skillName: r.progress_categories?.name ?? "",
    parentName: r.progress_categories?.parent_id ? (parentNames[r.progress_categories.parent_id] ?? null) : null,
    lessonDate: r.lesson_date,
    note: r.note,
    coachName: r.accounts?.name ?? null,
  }));
}

// 오늘 가르친 기술 여러 개를 한 번에 기록
export async function recordProgress(
  profileId: string,
  categoryIds: string[],
  lessonDate: string,
  note: string | null
): Promise<void> {
  if (categoryIds.length === 0) return;
  const coachAccountId = await getMyAccountId();

  const rows = categoryIds.map((cid) => ({
    profile_id: profileId,
    category_id: cid,
    coach_account_id: coachAccountId,
    lesson_date: lessonDate,
    // 메모는 첫 기술에만 붙임 (하루 단위 메모 성격)
    note: note,
  }));
  const { error } = await supabase.from("progress_records").insert(rows);
  if (error) throw new Error("진도 기록에 실패했어요: " + error.message);
}

export async function deleteProgressRecord(id: string): Promise<void> {
  const { error } = await supabase.from("progress_records").delete().eq("id", id);
  if (error) throw new Error("삭제에 실패했어요: " + error.message);
}

// 특정 날짜의 그 회원 진도 기록 전체 삭제 (날짜 카드 삭제용)
export async function deleteProgressByDate(profileId: string, lessonDate: string): Promise<void> {
  const { error } = await supabase
    .from("progress_records").delete()
    .eq("profile_id", profileId).eq("lesson_date", lessonDate);
  if (error) throw new Error("삭제에 실패했어요: " + error.message);
}

// 특정 날짜의 메모 수정 (그 날 기록들의 note 갱신)
export async function updateProgressNote(profileId: string, lessonDate: string, note: string | null): Promise<void> {
  const { error } = await supabase
    .from("progress_records").update({ note })
    .eq("profile_id", profileId).eq("lesson_date", lessonDate);
  if (error) throw new Error("메모 수정에 실패했어요: " + error.message);
}

// 진도 기록용 회원 목록 (센터 회원)
export async function fetchProgressMembers(centerId: string): Promise<{ profileId: string; name: string }[]> {
  // egress 감사(2026-09-15) — 상한 없는 전체 조회라 안전판만 추가.
  const { data, error } = await supabase
    .from("center_members")
    .select("profile_id, profiles(name)")
    .eq("center_id", centerId)
    .limit(2000);
  if (error) throw new Error("회원 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    profileId: r.profile_id, name: r.profiles?.name ?? "(이름 없음)",
  }));
}
