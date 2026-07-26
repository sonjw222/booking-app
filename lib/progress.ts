/*
  진도표 - 카테고리(기술 목록) 관리
  - 센터마다 계층 구조로 기술을 구성 (대분류 > 세부기술)
  - 예) 피겨: 점프 > 왈츠점프/살코, 스핀 > 카멜스핀 ...
*/

import { supabase } from "./supabaseClient";

export type ProgressCategory = {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
};

// 대분류 + 그 안의 세부기술 트리
export type CategoryNode = ProgressCategory & { children: ProgressCategory[] };

// 센터의 전체 카테고리 (평면)
export async function fetchCategories(centerId: string): Promise<ProgressCategory[]> {
  const { data, error } = await supabase
    .from("progress_categories")
    .select("id, parent_id, name, sort_order")
    .eq("center_id", centerId)
    .order("sort_order");
  if (error) throw new Error("기술 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((c: any) => ({
    id: c.id, parentId: c.parent_id, name: c.name, sortOrder: c.sort_order,
  }));
}

// 트리로 묶기 (대분류 → 세부기술)
export function buildCategoryTree(cats: ProgressCategory[]): CategoryNode[] {
  const tops = cats.filter((c) => !c.parentId);
  return tops.map((t) => ({
    ...t,
    children: cats.filter((c) => c.parentId === t.id),
  }));
}

// 대분류 추가
export async function addTopCategory(centerId: string, name: string, sortOrder: number): Promise<void> {
  const { error } = await supabase
    .from("progress_categories")
    .insert({ center_id: centerId, parent_id: null, name, sort_order: sortOrder });
  if (error) throw new Error("추가에 실패했어요: " + error.message);
}

// 세부기술 추가 (대분류 밑에)
export async function addSubCategory(centerId: string, parentId: string, name: string, sortOrder: number): Promise<void> {
  const { error } = await supabase
    .from("progress_categories")
    .insert({ center_id: centerId, parent_id: parentId, name, sort_order: sortOrder });
  if (error) throw new Error("추가에 실패했어요: " + error.message);
}

// 이름 수정
export async function renameCategory(id: string, name: string): Promise<void> {
  const { error } = await supabase
    .from("progress_categories")
    .update({ name })
    .eq("id", id);
  if (error) throw new Error("수정에 실패했어요: " + error.message);
}

// 삭제 (하위도 FK on delete로 정리되지 않으므로, 하위 먼저 지움)
export async function deleteCategory(id: string): Promise<void> {
  // 세부기술(자식) 먼저 삭제
  await supabase.from("progress_categories").delete().eq("parent_id", id);
  const { error } = await supabase.from("progress_categories").delete().eq("id", id);
  if (error) throw new Error("삭제에 실패했어요: " + error.message);
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
  const parentIds = Array.from(new Set(rows.map((r: any) => r.progress_categories?.parent_id).filter(Boolean)));
  const parentNames: Record<string, string> = {};
  if (parentIds.length > 0) {
    const { data: parents } = await supabase
      .from("progress_categories")
      .select("id, name")
      .in("id", parentIds);
    for (const p of parents ?? []) parentNames[(p as any).id] = (p as any).name;
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
  const { data: authData } = await supabase.auth.getUser();
  let coachAccountId: string | null = null;
  if (authData.user) {
    const { data: acc } = await supabase
      .from("accounts").select("id").eq("auth_id", authData.user.id).maybeSingle();
    coachAccountId = acc?.id ?? null;
  }

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
  const { data, error } = await supabase
    .from("center_members")
    .select("profile_id, profiles(name)")
    .eq("center_id", centerId);
  if (error) throw new Error("회원 목록을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    profileId: r.profile_id, name: r.profiles?.name ?? "(이름 없음)",
  }));
}
