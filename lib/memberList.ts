/*
  회원 목록 조회 공용 헬퍼 (PERF-030/032/033).

  PostgREST는 (1) 응답 행 수를 서버 설정 max-rows(기본 1000, 이 프로젝트의 실제 값은 미확인 —
  lib/classes.ts fetchClasses 주석은 1000행에서 잘린 것을 실제로 관측했다고 기록)로 조용히 자르고,
  (2) .in()에 UUID를 많이 나열하면 요청 URL이 너무 길어져 Bad Request로 거부한다.
  이 파일은 둘 다 "조용히 잘리거나 실패한 결과를 정상으로 오인하지 않도록" 하는 순수 헬퍼만 둔다.
*/

export const ID_CHUNK_SIZE = 150;     // lib/classes.ts·fetchMonthData와 동일한 .in() 청크 크기
export const PAGE_SIZE = 1000;        // PostgREST 기본 max-rows와 같은 페이지 크기
export const MEMBER_FETCH_CONCURRENCY = 6;   // 브라우저 동시 연결 한도(HTTP/1.1은 호스트당 6)를 넘지 않게

export function chunkArray<T>(items: readonly T[], size: number = ID_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 입력 순서를 유지하면서 최대 `limit`개씩 동시에 실행한다. 하나라도 실패하면 reject(남은 작업은 시작하지 않음). */
export async function mapWithConcurrency<T, R>(
  items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); } catch (e) { failed = true; throw e; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type PageResult<T> = { data: T[] | null; error: { message: string } | null; count?: number | null };

/**
 * range 기반 전량 조회. `build(from, to, wantCount)`는 매번 "새" 쿼리 빌더를 돌려줘야 하고, 정렬은 호출자가
 * 안정적 키(예: 정렬 컬럼 + id)로 지정해야 한다(동률 정렬이면 페이지 경계에서 중복/누락이 생긴다).
 *  - 첫 페이지에서 정확한 총 개수(count)를 받아 두고, 서버가 실제로 돌려준 행 수(= 유효 max-rows)를 step으로
 *    삼아 나머지 페이지를 병렬 조회한다 → 서버 max-rows가 1000보다 작아도 누락되지 않는다.
 *  - count를 못 받으면(null) "반환 행 수 == 요청 상한이면 더 가져오기" 규칙으로 순차 조회한다.
 *  - key가 있으면 중복 행(조회 중 삽입으로 페이지가 밀린 경우)을 제거한다.
 *  - 끝났는데 count보다 적으면(조회 중 삭제 등으로 밀림) 부분 결과를 정상처럼 보여주지 않고 오류를 던진다.
 */
export async function fetchAllPages<T>(
  build: (from: number, to: number, wantCount: boolean) => PromiseLike<PageResult<T>>,
  opts: { pageSize?: number; key?: (row: T) => string; errorLabel: string; concurrency?: number },
): Promise<T[]> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const fail = (m: string) => new Error(`${opts.errorLabel}: ${m}`);

  const first = await build(0, pageSize - 1, true);
  if (first.error) throw fail(first.error.message);
  const firstRows = first.data ?? [];
  const total = typeof first.count === "number" ? first.count : null;
  const pages: T[][] = [firstRows];

  if (total !== null) {
    const step = firstRows.length;
    if (total > step) {
      if (step === 0) throw fail("응답이 비어 있어요");
      const offsets: number[] = [];
      for (let from = step; from < total; from += step) offsets.push(from);
      const rest = await mapWithConcurrency(offsets, opts.concurrency ?? MEMBER_FETCH_CONCURRENCY, async (from) => {
        const r = await build(from, from + pageSize - 1, false);
        if (r.error) throw fail(r.error.message);
        return r.data ?? [];
      });
      pages.push(...rest);
    }
  } else if (firstRows.length >= pageSize) {
    for (let from = pageSize; ; from += pageSize) {
      const r = await build(from, from + pageSize - 1, false);
      if (r.error) throw fail(r.error.message);
      const rows = r.data ?? [];
      pages.push(rows);
      if (rows.length < pageSize) break;
    }
  }

  let all = pages.flat();
  if (opts.key) {
    const seen = new Set<string>();
    all = all.filter((row) => { const k = opts.key!(row); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (total !== null && all.length < total) throw fail("일부 행을 불러오지 못했어요. 다시 시도해 주세요");
  return all;
}

/** .in() 대상 id를 청크로 나눠 병렬 조회하고 결과를 이어 붙인다(청크 순서 유지). */
export async function fetchByIdChunks<R>(
  ids: readonly string[], fetchChunk: (chunk: string[]) => Promise<R[]>,
  opts: { chunkSize?: number; concurrency?: number } = {},
): Promise<R[]> {
  const chunks = chunkArray(ids, opts.chunkSize ?? ID_CHUNK_SIZE);
  const results = await mapWithConcurrency(chunks, opts.concurrency ?? MEMBER_FETCH_CONCURRENCY, (c) => fetchChunk(c));
  return results.flat();
}
