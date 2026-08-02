"use client";

/*
  오전/오후 + 시 + 분 선택 입력 (UI-004 B-2)
  - value/onChange는 기존 <input type="time">과 동일한 "HH:mm"(24시간제) 문자열을 사용해
    lib/classes.ts의 저장 형식(toKstIso)을 그대로 재사용한다 — 저장 로직은 변경하지 않는다.
  - 분 select는 항상 존재하고 기본값 "00"이 이미 선택돼 있어, 관리자가 오전/오후와 시만
    선택해도 분은 자동으로 00분이 된다.
  - 오전 12시(자정, 00:00)/오후 12시(정오, 12:00) 변환은 표준 12h→24h 공식
    (hour12 % 12, PM이면 +12)으로 처리 — 흔한 실수(12시를 그대로 더하는 것)를 피한다.
*/

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1); // 1~12
const MINUTES = Array.from({ length: 60 }, (_, i) => i);   // 0~59

export function parse24h(value: string): { period: "AM" | "PM"; hour12: number; minute: number } {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(value ?? "");
  let h = m ? parseInt(m[1], 10) : 0;
  let min = m ? parseInt(m[2], 10) : 0;
  if (Number.isNaN(h) || h < 0 || h > 23) h = 0;
  if (Number.isNaN(min) || min < 0 || min > 59) min = 0;
  const period: "AM" | "PM" = h < 12 ? "AM" : "PM";
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return { period, hour12, minute: min };
}

export function to24h(period: "AM" | "PM", hour12: number, minute: number): string {
  let h = hour12 % 12; // 12 -> 0
  if (period === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export default function AmPmTimeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const { period, hour12, minute } = parse24h(value);

  return (
    <div className="ampm-time-input">
      <select
        className="input-field ampm-select"
        value={period}
        disabled={disabled}
        onChange={(e) => onChange(to24h(e.target.value as "AM" | "PM", hour12, minute))}
      >
        <option value="AM">오전</option>
        <option value="PM">오후</option>
      </select>
      <select
        className="input-field ampm-select"
        value={hour12}
        disabled={disabled}
        onChange={(e) => onChange(to24h(period, parseInt(e.target.value, 10), minute))}
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>{h}시</option>
        ))}
      </select>
      <select
        className="input-field ampm-select"
        value={minute}
        disabled={disabled}
        onChange={(e) => onChange(to24h(period, hour12, parseInt(e.target.value, 10)))}
      >
        {MINUTES.map((m) => (
          <option key={m} value={m}>{String(m).padStart(2, "0")}분</option>
        ))}
      </select>
    </div>
  );
}
