/*
  예약조건(membership_schedule_rules) 표시용 pure helper — 회원 구매 sheet의 예약조건 accordion이 쓴다(2026-10-03).
  DB day_of_week는 0=일 … 6=토지만 화면 순서는 월→일이라 DB 숫자를 그대로 정렬하지 않고 별도 sort key를 쓴다.
  도메인 의미(lib/passes.ts ruleToText): dayOfWeek null = "모든 요일", startTime null = "모든 시간", classTitle null = "모든 수업".
  규칙: "모든 요일" 그룹을 맨 앞(요일 조건과 섞지 않음) → 월~일. 같은 요일 안에서는 "모든 시간"이 맨 위, 이어서 시작 시각 오름차순,
  같은 시각이면 "모든 수업"이 먼저, 그다음 수업명 가나다, 마지막으로 id(안정 정렬).
*/
import type { ScheduleRule } from "./passes";

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

/** 월=0 … 일=6. null(모든 요일)은 -1로 맨 앞. */
export function dayDisplayKey(dayOfWeek: number | null): number {
  return dayOfWeek === null ? -1 : (dayOfWeek + 6) % 7;
}

export function sortRulesForDisplay<T extends Pick<ScheduleRule, "id" | "dayOfWeek" | "startTime" | "classTitle">>(rules: T[]): T[] {
  return [...rules].sort((a, b) => {
    const d = dayDisplayKey(a.dayOfWeek) - dayDisplayKey(b.dayOfWeek);
    if (d !== 0) return d;
    if (a.startTime !== b.startTime) {
      if (a.startTime === null) return -1;
      if (b.startTime === null) return 1;
      return a.startTime < b.startTime ? -1 : 1;   // "HH:MM" 고정 길이라 문자열 비교 = 시각 비교
    }
    if (a.classTitle !== b.classTitle) {
      if (a.classTitle === null) return -1;
      if (b.classTitle === null) return 1;
      const c = a.classTitle.localeCompare(b.classTitle, "ko");
      if (c !== 0) return c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type RuleRowView = { id: string; time: string; title: string };
export type RuleDayGroup = { dayOfWeek: number | null; label: string; rows: RuleRowView[] };

/** 정렬 + 요일별 그룹. 한 조건 = 한 row. */
export function groupRulesByDay(rules: ScheduleRule[]): RuleDayGroup[] {
  const groups: RuleDayGroup[] = [];
  for (const r of sortRulesForDisplay(rules)) {
    let g = groups[groups.length - 1];
    if (!g || g.dayOfWeek !== r.dayOfWeek) {
      g = { dayOfWeek: r.dayOfWeek, label: r.dayOfWeek === null ? "모든 요일" : `${DAY_NAMES[r.dayOfWeek]}요일`, rows: [] };
      groups.push(g);
    }
    g.rows.push({ id: r.id, time: r.startTime === null ? "모든 시간" : r.startTime, title: r.classTitle === null ? "모든 수업" : r.classTitle });
  }
  return groups;
}

/** collapsed 상태의 한 줄 요약: "예약조건 8개 · 월~일" (조건 전문을 이어붙이지 않는다). 0개면 null. */
export function summarizeRules(rules: ScheduleRule[]): string | null {
  if (rules.length === 0) return null;
  const keys = [...new Set(rules.filter((r) => r.dayOfWeek !== null).map((r) => dayDisplayKey(r.dayOfWeek)))].sort((a, b) => a - b);
  const names = keys.map((k) => DAY_NAMES[(k + 1) % 7]);
  let days = "";
  if (keys.length === 0) days = "모든 요일";
  else if (keys.length >= 3 && keys[keys.length - 1] - keys[0] === keys.length - 1) days = `${names[0]}~${names[names.length - 1]}`;
  else days = names.join("·");
  if (keys.length > 0 && rules.some((r) => r.dayOfWeek === null)) days = `모든 요일 + ${days}`;
  return `예약조건 ${rules.length}개 · ${days}`;
}

/** 상품별 독립 펼침 상태 토글(불변). */
export function toggleExpanded(open: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(open);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
