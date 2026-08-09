// TEMP-DIAG(P2-20, 제거 예정): race condition 조사 전용 초경량 이벤트 버퍼.
// console.log는 Playwright CDP 왕복 비용이 있어 타이밍 자체를 바꿔버린다는 것을 직전 시도에서
// 실측으로 확인했다(로그를 넣자 원래 증상이 사라지고 다른 증상이 나타남) — 그래서 이번엔
// window 전역 배열에 {t: performance.now(), code, ...data}만 push하고, 테스트가 끝난 뒤
// 한 번에 꺼내 출력한다(타이밍 임계 구간 안에서는 아무 것도 출력하지 않음).
export function diagEvent(code: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const w = window as any;
  if (!w.__p220) w.__p220 = [];
  w.__p220.push({ t: Math.round(performance.now() * 100) / 100, code, ...data });
}
