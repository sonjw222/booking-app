import type { CenterMember } from "./members";
export type MemberWorklist = "all" | "expiring" | "low_balance" | "inactive";
export function filterMemberWorklist(members: CenterMember[], mode: MemberWorklist, now = new Date()) {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(now);
  const day = (date: string) => Date.parse(date.slice(0, 10) + "T00:00:00Z");
  return members.filter((m) => {
    if (mode === "expiring") { const left = m.expiresAt ? (day(m.expiresAt) - day(today)) / 86400000 : NaN; return left >= 0 && left <= 7; }
    if (mode === "low_balance") return m.hasPass && m.remainingCount != null && m.remainingCount >= 0 && m.remainingCount <= 2;
    if (mode === "inactive") return !m.lastAttendedAt || day(today) - day(m.lastAttendedAt) >= 30 * 86400000;
    return true;
  });
}
