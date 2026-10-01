/*
  수업 등록 "한 날 여러 타임" 순수 로직(2026-10-02).
  - 새 수업 등록 전용: 기본 시간 1개(폼의 start/end = 첫 번째 슬롯) + 추가 슬롯(extra) 배열. 수정 화면은 기존처럼 단일 수업 수정.
  - 슬롯마다 기존 isValidClassTimeRange 검증을 그대로 적용하고, 완전히 같은 슬롯(시작·종료 동일)만 막는다.
    일부 겹침(10:00~11:00 + 10:30~11:30)은 기존 스케줄 충돌 정책(룸/강사 겹침은 경고만, 저장은 진행)과 같이 허용한다.
  - 생성은 여러 class row를 한 번의 create_recurring_classes_safe 호출(=한 트랜잭션)로 만든다 — DB 변경 없음.
*/
import { isValidClassTimeRange } from "./classes";

export type TimeSlot = { id: string; start: string; end: string };
export type SlotTimes = { start: string; end: string };

export const MAX_TIME_SLOTS = 12;   // 한 날(또는 한 요일)에 등록할 수 있는 최대 타임 수(실수로 과도하게 늘리는 것 방지)

let slotSeq = 0;
export function makeSlot(start: string, end: string, id?: string): TimeSlot {
  slotSeq += 1;
  return { id: id ?? `slot-${slotSeq}`, start, end };
}

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

// 새 슬롯의 기본값: 마지막 슬롯의 종료 시각부터 1시간(자정을 넘기면 마지막 슬롯과 같은 길이로 하루 안에 맞추기 어려우므로 23:00~23:59 보정).
export function nextSlotTimes(prev: SlotTimes | undefined): SlotTimes {
  if (!prev || !/^\d{1,2}:\d{2}$/.test(prev.end)) return { start: "10:00", end: "11:00" };
  const s = toMin(prev.end);
  if (s >= 23 * 60) return { start: "22:00", end: "23:00" };
  return { start: fromMin(s), end: fromMin(Math.min(s + 60, 24 * 60 - 1)) };
}

export function addSlot(extra: TimeSlot[], first: SlotTimes): TimeSlot[] {
  if (extra.length + 1 >= MAX_TIME_SLOTS) return extra;
  const last = extra.length > 0 ? extra[extra.length - 1] : first;
  const t = nextSlotTimes(last);
  return [...extra, makeSlot(t.start, t.end)];
}

export function removeSlot(extra: TimeSlot[], id: string): TimeSlot[] {
  return extra.filter((s) => s.id !== id);   // 첫 번째(기본) 슬롯은 extra 배열에 없으므로 항상 최소 1개가 남는다
}

export function updateSlot(extra: TimeSlot[], id: string, patch: Partial<SlotTimes>): TimeSlot[] {
  return extra.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

// 첫 번째 슬롯 + 추가 슬롯 → 실제 슬롯 목록(시작 시각 순으로 정렬해 생성 순서를 예측 가능하게)
export function allSlots(first: SlotTimes, extra: SlotTimes[] | undefined): SlotTimes[] {
  const list = [{ start: first.start, end: first.end }, ...(extra ?? []).map((s) => ({ start: s.start, end: s.end }))];
  return list;
}

// 저장 전 검증(없으면 null): 각 슬롯 입력/범위 + 완전 중복 차단. label은 "화요일" 같은 접두사.
export function validateSlots(slots: SlotTimes[], label = ""): string | null {
  const prefix = label ? `${label} ` : "";
  const seen = new Set<string>();
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const name = slots.length > 1 ? `${prefix}시간 ${i + 1}` : `${prefix}시간`;
    if (!s.start || !s.end) return `${name}의 시작·종료 시간을 입력해주세요`;
    if (!isValidClassTimeRange(s.start, s.end)) {
      return `${name}: 종료시간은 시작시간 이후여야 해요 (자정을 넘기는 경우는 6시간 이내만 허용)`;
    }
    const key = `${s.start}~${s.end}`;
    if (seen.has(key)) return `${prefix}같은 시간(${s.start}~${s.end})이 두 번 들어 있어요`;
    seen.add(key);
  }
  return null;
}

// 생성될 수업 수 = 날짜 수 × 슬롯 수
export function countClasses(dateCount: number, slotCount: number): number {
  return Math.max(0, dateCount) * Math.max(1, slotCount);
}

// 요일별 모드: 요일마다 (그 요일 날짜 수 × 그 요일 슬롯 수)의 합
export function countPerDayClasses(days: { dateCount: number; slotCount: number }[]): number {
  return days.reduce((sum, d) => sum + countClasses(d.dateCount, d.slotCount), 0);
}
