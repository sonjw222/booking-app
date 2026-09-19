/** Calendar dates are date-only values; UTC arithmetic avoids local DST offsets. */
export function calendarDate(date: Date): string { return date.toISOString().slice(0, 10); }
export function weekDates(selected: string): string[] {
  const start = new Date(`${selected}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  return Array.from({ length: 7 }, (_, i) => calendarDate(new Date(start.getTime() + i * 86400000)));
}
export function monthCalendarRange(year: number, month: number) {
  const first = calendarDate(new Date(Date.UTC(year, month - 1, 1)));
  const last = calendarDate(new Date(Date.UTC(year, month, 0)));
  return { from: weekDates(first)[0], to: weekDates(last)[6] };
}
export function previousDateRange(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const days = Math.round((end - start) / 86400000) + 1;
  return { from: calendarDate(new Date(start - days * 86400000)), to: calendarDate(new Date(start - 86400000)) };
}
