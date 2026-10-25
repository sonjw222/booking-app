/* V07: 데스크톱 홈 "종목 둘러보기" 열 수. 항목이 한 줄에 들어가는 최대 개수(perRow)보다 조금만 많으면(예: 8칸에 9개) 마지막 한 개가
   둘째 줄에 혼자 남아 큰 빈 공간이 생겼다. 필요한 줄 수는 그대로 두고 줄마다 항목 수를 고르게 나눈다(9개 → 5+4, 8개 → 8, 17개 → 6+6+5 …).
   모바일(4열, 기본 8개/전체 종목 정책)은 이 함수를 쓰지 않는다. */
export function balancedCategoryColumns(count: number, availableWidth: number, minCell = 92, gap = 18): number {
  if (count <= 0) return 1;
  const perRow = Math.max(1, Math.floor((availableWidth + gap) / (minCell + gap)));
  if (count <= perRow) return count;                 // 한 줄에 다 들어가면 항목 수만큼 열
  const rows = Math.ceil(count / perRow);
  return Math.ceil(count / rows);                    // 줄 수는 유지하고 줄마다 고르게
}
