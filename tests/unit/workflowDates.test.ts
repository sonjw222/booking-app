import { describe, expect, it } from "vitest";
import { monthCalendarRange, weekDates, previousDateRange } from "../../lib/calendarRange";
import { filterMemberWorklist } from "../../lib/memberWorklist";
import type { CenterMember } from "../../lib/members";

describe("calendar query boundaries", () => {
  it("compares inclusive periods with equal day counts", () => {
    expect(previousDateRange("2026-09-01", "2026-09-19")).toEqual({ from: "2026-08-13", to: "2026-08-31" });
    expect(previousDateRange("2026-09-19", "2026-09-19")).toEqual({ from: "2026-09-18", to: "2026-09-18" });
    expect(previousDateRange("2026-09-20", "2026-09-19")).toBeNull();
  });
  it("includes both neighboring months needed by weekly views", () => {
    expect(monthCalendarRange(2026, 9)).toEqual({ from: "2026-08-30", to: "2026-10-03" });
  });
  it("handles year boundaries and leap dates", () => {
    expect(weekDates("2027-01-01")).toEqual(["2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(weekDates("2024-02-29")).toContain("2024-02-29");
  });
});
describe("member work queues", () => {
  const now = new Date("2026-09-18T15:01:00Z"); // September 19 KST
  const member = (fields: Partial<CenterMember>) => fields as CenterMember;
  it("includes today through day seven, not expired or day eight", () => {
    const members = ["2026-09-18", "2026-09-19", "2026-09-26", "2026-09-27"].map((expiresAt) => member({ expiresAt }));
    expect(filterMemberWorklist(members, "expiring", now).map((m) => m.expiresAt)).toEqual(["2026-09-19", "2026-09-26"]);
  });
  it("requires an existing pass and a finite low balance", () => {
    const members = [member({ hasPass: false, remainingCount: 0 }), member({ hasPass: true, remainingCount: null }), member({ hasPass: true, remainingCount: 2 }), member({ hasPass: true, remainingCount: 3 })];
    expect(filterMemberWorklist(members, "low_balance", now)).toEqual([members[2]]);
  });
  it("includes absent attendance and the 30-day boundary", () => {
    const members = [member({ lastAttendedAt: null }), member({ lastAttendedAt: "2026-08-20" }), member({ lastAttendedAt: "2026-08-21" })];
    expect(filterMemberWorklist(members, "inactive", now)).toEqual(members.slice(0, 2));
  });
});
