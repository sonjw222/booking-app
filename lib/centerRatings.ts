/* 센터별 평균 별점/후기 수 — center_reviews(공개 조회 정책)의 실제 값만 집계한다.
   실패하면 throw — 호출자가 "평점이 없음"과 "불러오지 못함"을 구분해 처리한다. */
import { supabase } from "./supabaseClient";
import { aggregateRatings, type CenterRating } from "./centerDiscovery";

export async function fetchCenterRatings(centerIds: readonly string[]): Promise<Record<string, CenterRating>> {
  const rows: { center_id: string; rating: number }[] = [];
  const CHUNK = 100, PAGE = 1000;
  for (let i = 0; i < centerIds.length; i += CHUNK) {
    const chunk = centerIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from("center_reviews").select("center_id, rating").in("center_id", chunk)
        .order("id", { ascending: true })   // 안정적인 고유 정렬 — 정렬 없는 range 는 페이지 사이에 행이 중복·누락될 수 있다
        .range(from, from + PAGE - 1);
      if (error) throw new Error("평점을 불러오지 못했어요: " + error.message);
      rows.push(...((data ?? []) as { center_id: string; rating: number }[]));
      if (!data || data.length < PAGE) break;
    }
  }
  return aggregateRatings(rows);
}
