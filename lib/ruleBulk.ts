/*
  수강권 예약조건 일괄 설정(2026-10-03) — 선택한 여러 수강권에 같은 예약조건(요일/시간/수업명)을 추가한다.
  새 RPC 없이 기존 addRule(membership_schedule_rules INSERT, 수강권별 RLS)을 상품별로 반복 호출한다. 부분 실패를 숨기지 않고 상품별 결과를 돌려준다.
  이미 같은 조건이 있으면 중복 생성하지 않고 "이미 적용됨"으로 센다(최종 상태가 요청과 같으므로 정상).
  일괄 설정은 "선택한 모든 수강권에 같은 조건"이다 — 요일 고정(autoBookDays) 수강권이 요청한 요일 전체를 받을 수 없으면 일부 요일만 조용히 넣지 않고,
  DB write를 시작하기 전에(preflight) 전체 작업을 막고 어떤 수강권이 왜 안 되는지 돌려준다.
*/
export type RuleLike = { dayOfWeek: number | null; startTime: string | null; classTitle: string | null };
export type BulkTarget = { id: string; name: string; autoBookDays: number[] | null; existingRules: RuleLike[] };
export type BulkRuleInput = { days: (number | null)[]; startTime: string | null; classTitle: string | null };
export type BulkRuleResult = {
  succeeded: { id: string; name: string; added: number }[];
  skipped: { id: string; name: string; reason: "already_exists" }[];   // 요청한 조건이 이미 모두 있음(정상)
  failed: { id: string; name: string; error: string }[];
  incompatible: IncompatibleTarget[];   // preflight 차단 — 비어 있지 않으면 write는 하나도 일어나지 않았다
};
export type IncompatibleTarget = { id: string; name: string; reason: "locked_days"; lockedDays: number[] };

/** DB write 전 점검: 요일 고정 수강권이 요청한 요일 전체(+"모든 요일")를 받을 수 없으면 비호환. */
export function preflightBulkRules(targets: BulkTarget[], input: Pick<BulkRuleInput, "days">): IncompatibleTarget[] {
  const out: IncompatibleTarget[] = [];
  for (const t of targets) {
    const lock = t.autoBookDays && t.autoBookDays.length > 0 ? t.autoBookDays : null;
    if (lock && input.days.some((d) => d === null || !lock.includes(d))) out.push({ id: t.id, name: t.name, reason: "locked_days", lockedDays: [...lock] });
  }
  return out;
}

const same = (a: RuleLike, b: { day: number | null; startTime: string | null; classTitle: string | null }) =>
  a.dayOfWeek === b.day && (a.startTime ?? null) === (b.startTime ?? null) && (a.classTitle ?? null) === (b.classTitle ?? null);

export async function applyRulesToProducts(
  targets: BulkTarget[], input: BulkRuleInput,
  addRule: (productId: string, day: number | null, startTime: string | null, classTitle: string | null) => Promise<void>,
): Promise<BulkRuleResult> {
  const result: BulkRuleResult = { succeeded: [], skipped: [], failed: [], incompatible: preflightBulkRules(targets, input) };
  if (result.incompatible.length > 0) return result;   // 하나라도 비호환이면 아무것도 쓰지 않는다
  const time = input.startTime || null;
  const title = input.classTitle?.trim() || null;
  for (const t of targets) {
    const todo = input.days.filter((d) => !t.existingRules.some((r) => same(r, { day: d, startTime: time, classTitle: title })));
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

const DAY = ["일", "월", "화", "수", "목", "금", "토"];
export function bulkRuleSummary(r: BulkRuleResult): { message: string; hasFailure: boolean } {
  if (r.incompatible.length > 0) {
    const list = r.incompatible.slice(0, 3).map((t) => `${t.name}(고정 ${t.lockedDays.map((d) => DAY[d]).join("·")})`).join(", ");
    return { message: `요일 고정 수강권이 선택한 요일을 모두 받을 수 없어 아무것도 적용하지 않았어요: ${list}${r.incompatible.length > 3 ? ` 외 ${r.incompatible.length - 3}개` : ""}. 요일을 바꾸거나 해당 수강권을 선택에서 빼주세요`, hasFailure: true };
  }
  const parts: string[] = [];
  if (r.succeeded.length) parts.push(`${r.succeeded.length}개 수강권에 적용했어요`);
  if (r.skipped.length) parts.push(`${r.skipped.length}개는 이미 같은 조건이 있어요`);
  if (r.failed.length) parts.push(`${r.failed.length}개는 실패했어요(${r.failed.map((f) => f.name).slice(0, 3).join(", ")}${r.failed.length > 3 ? " 외" : ""})`);
  return { message: parts.join(" · ") || "적용할 항목이 없어요", hasFailure: r.failed.length > 0 };
}
