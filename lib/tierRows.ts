/*
  CountPriceEditor 행 갱신 순수 로직 (PERF-041).
  해당 회차 행만 새 객체로 바꾸고 나머지 행은 같은 참조를 유지한다 → memo된 행 컴포넌트가 입력 중에 다시 렌더되지 않는다.
  저장되는 데이터(TierDraft 배열의 값/순서)는 기존 인라인 구현 `rows.map(r => r.count === count ? {...r, ...patch} : r)`과 동일.
*/
import type { TierDraft } from "./selectableCount";

export function patchTierRow(rows: TierDraft[], count: number, patch: Partial<TierDraft>): TierDraft[] {
  return rows.map((r) => (r.count === count ? { ...r, ...patch } : r));
}
