/* 관리자 출결 처리 보조: 아직 시작하지 않은 수업에 출석/노쇼를 찍으려 할 때 한 번 더 확인한다(오탭 방지).
   서버 규칙은 바꾸지 않는다 — 이 확인은 화면 안내일 뿐이며 통과하면 기존과 똑같이 처리된다. */
export function isClassNotStarted(date: string, start: string, now: Date = new Date()): boolean {
  const t = new Date(`${date}T${start}:00+09:00`).getTime();   // 수업 날짜·시각은 KST 기준
  return Number.isFinite(t) && t > now.getTime();
}

export function futureAttendanceMessage(name: string, status: "attended" | "no_show"): string {
  const label = status === "attended" ? "출석" : "결석(노쇼)";
  return `${name}님을 ${label}으로 처리할까요?\n\n· 아직 시작하지 않은 수업이에요\n· 잘못 눌렀다면 목록에서 상태를 되돌릴 수 있어요`;
}
