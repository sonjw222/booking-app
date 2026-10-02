/*
  수업 목록(시트용) 비동기 로딩의 stale-race 방어 — 센터가 바뀐 뒤 늦게 도착하는 "이전 센터" 요청의 성공/실패가 현재 센터 state를 건드리지 못하게 한다.
  getCurrent()는 "지금 선택된 센터"를 돌려준다(호출자는 centerId 변경을 추적하는 effect에서만 그 ref를 갱신한다 — 이 함수 안에서 덮어쓰지 않는다).
  · 시작: 목록을 먼저 비운다(이전 센터/이전 시트의 값을 재사용하지 않음)
  · 성공: 여전히 같은 센터일 때만 반영
  · 실패: 여전히 같은 센터일 때만 빈 목록으로 비운다(오래된 요청의 실패가 새 센터의 정상 목록을 지우면 안 된다)
*/
export async function loadClassOptionsGuarded<T>(opts: {
  centerId: string | null;
  getCurrent: () => string | null;
  fetchOptions: (centerId: string) => Promise<T[]>;
  setOptions: (list: T[]) => void;
}): Promise<void> {
  const { centerId, getCurrent, fetchOptions, setOptions } = opts;
  setOptions([]);
  if (!centerId) return;
  try {
    const list = await fetchOptions(centerId);
    if (getCurrent() === centerId) setOptions(list);
  } catch {
    if (getCurrent() === centerId) setOptions([]);
  }
}
