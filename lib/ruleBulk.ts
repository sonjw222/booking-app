/*
  수강권 예약조건 일괄 설정(2026-10-03) — 선택한 여러 수강권에 같은 예약조건(요일/시간/수업명)을 추가한다.
  새 RPC 없이 기존 addRule(membership_schedule_rules INSERT, 수강권별 RLS)을 상품별로 반복 호출한다. 부분 실패를 숨기지 않고 상품별 결과를 돌려준다.
  이미 같은 조건이 있는 수강권은 건너뛴다(중복 방지). 요일 고정(autoBookDays) 수강권은 고정 요일 밖의 조건을 추가하지 않는다.
*/
export type RuleLike = { dayOfWeek: number | null; startTime: string | null; classTitle: string | null };
export type BulkTarget = { id: string; name: string; autoBookDays: number[] | null; existingRules: RuleLike[] };
export type BulkRuleInput = { days: (number | null)[]; startTime: string | null; classTitle: string | null };
export type BulkRuleResult = {
  succeeded: { id: string; name: string; added: number }[];
  skipped: { id: string; name: string; reason: "already_exists" | "locked_days" }[];
  failed: { id: string; name: string; error: string }[];
};

const same = (a: RuleLike, b: { day: number | null; startTime: string | null; classTitle: string | null }) =>
  a.dayOfWeek === b.day && (a.startTime ?? null) === (b.startTime ?? null) && (a.classTitle ?? null) === (b.classTitle ?? null);

export async function applyRulesToProducts(
  targets: BulkTarget[], input: BulkRuleInput,
  addRule: (productId: string, day: number | null, startTime: string | null, classTitle: string | null) => Promise<void>,
): Promise<BulkRuleResult> {
  const result: BulkRuleResult = { succeeded: [], skipped: [], failed: [] };
  const time = input.startTime || null;
  const title = input.classTitle?.trim() || null;
  for (const t of targets) {
    const lock = t.autoBookDays && t.autoBookDays.length > 0 ? t.autoBookDays : null;
    const days = lock ? input.days.filter((d) => d !== null && lock.includes(d)) : input.days;
    const todo = days.filter((d) => !t.existingRules.some((r) => same(r, { day: d, startTime: time, classTitle: title })));
    if (days.length === 0) { result.skipped.push({ id: t.id, name: t.name, reason: "locked_days" }); continue; }
    if (todo.length === 0) { result.skipped.push({ id: t.id, name: t.name, reason: "already_exists" }); continue; }
    let added = 0;
    try {
      for (const d of todo) { await addRule(t.id, d, time, title); added++; }
      result.succeeded.push({ id: t.id, name: t.name, added });
    } catch (e) {
      result.failed.push({ id: t.id, name: t.name, error: (e as Error)?.message ?? "실패" });   // 일부 조건만 들어갔을 수 있다(실패로 보고)
    }
  }
  return result;
}

export function bulkRuleSummary(r: BulkRuleResult): { message: string; hasFailure: boolean } {
  const parts: string[] = [];
  if (r.succeeded.length) parts.push(`${r.succeeded.length}개 수강권에 적용했어요`);
  if (r.skipped.length) parts.push(`${r.skipped.length}개는 이미 있거나 고정 요일이라 건너뛰었어요`);
  if (r.failed.length) parts.push(`${r.failed.length}개는 실패했어요(${r.failed.map((f) => f.name).slice(0, 3).join(", ")}${r.failed.length > 3 ? " 외" : ""})`);
  return { message: parts.join(" · ") || "적용할 항목이 없어요", hasFailure: r.failed.length > 0 };
}
