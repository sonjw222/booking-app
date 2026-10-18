/* 관리자 센터 커서 페이지네이션 검증용 순수 함수(네트워크·DB·브라우저 없음).
   E2E 스펙(실제 서버 응답 + 실제 DOM)과 오프라인 단위 테스트(합성 데이터)가 같은 규칙을 쓰도록 분리했다.
   서버는 p_limit(30)+1행을 돌려주고(마지막 1행은 "다음 페이지 있음" 판별용 lookahead), 화면에는 앞 30행만 보인다.
   다음 페이지는 화면에 보인 마지막(30번째) 행을 커서로 요청하므로 lookahead 행이 다음 응답의 첫 행이어야 한다. */

export const PAGE_SIZE = 30;

export type PageCall = {
  ids: string[];
  body: { p_before_id?: string | null; p_status?: string; p_keyword?: string; p_limit?: number };
  status?: number;
};

export type Boundary =
  | "single-page-under-30"   // 첫 응답이 30행 미만 — 경계를 지나지 않음
  | "exactly-30"             // 첫 응답이 정확히 30행 — 더 보기 없음(경계 직전)
  | "exactly-31"             // 31행(30 + 1) — 더 보기 1회, 두 번째 페이지 1행(경계 바로 위)
  | "multi-page";            // 32행 이상

export type PaginationVerdict = {
  ok: boolean;
  problems: string[];
  boundary: Boundary;
  pages: number;
  expectedIds: string[]; // 서버 응답 기준으로 화면에 보여야 하는 id(첫 페이지 30개 포함, 순서 유지)
};

export const visibleOf = (c: PageCall): string[] => c.ids.slice(0, PAGE_SIZE);

function dupes(ids: string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const id of ids) { if (seen.has(id)) out.push(id); else seen.add(id); }
  return out;
}

export function classifyBoundary(calls: PageCall[]): Boundary {
  const first = calls[0]?.ids.length ?? 0;
  if (first < PAGE_SIZE) return "single-page-under-30";
  if (first === PAGE_SIZE) return "exactly-30";
  if (calls.length === 2 && calls[1].ids.length === 1) return "exactly-31";
  return "multi-page";
}

/** calls: 한 상태 탭의 admin_list_centers_page 응답을 요청 순서대로(첫 페이지 포함). domIds: 최종 화면의 카드 id 순서. */
export function verifyTabPagination(input: { calls: PageCall[]; domIds: string[]; moreButtonVisibleAtEnd: boolean }): PaginationVerdict {
  const { calls, domIds, moreButtonVisibleAtEnd } = input;
  const problems: string[] = [];
  const expectedIds = calls.flatMap(visibleOf);
  const verdict = (): PaginationVerdict => ({ ok: problems.length === 0, problems, boundary: classifyBoundary(calls), pages: calls.length, expectedIds });

  if (calls.length === 0) { problems.push("이 탭의 페이지 응답이 하나도 없음(첫 페이지 30개를 검증할 수 없음)"); return verdict(); }
  if (calls[0].body.p_before_id) problems.push(`첫 요청이 커서를 가짐(p_before_id=${calls[0].body.p_before_id})`);

  calls.forEach((c, i) => {
    if (c.status !== undefined && c.status !== 200) problems.push(`페이지 ${i + 1} 응답 status=${c.status}`);
    if (c.ids.length > PAGE_SIZE + 1) problems.push(`페이지 ${i + 1} 응답이 ${c.ids.length}행(최대 ${PAGE_SIZE + 1}행 — limit+lookahead 초과)`);
    if (c.body.p_limit !== undefined && c.body.p_limit !== PAGE_SIZE) problems.push(`페이지 ${i + 1} p_limit=${c.body.p_limit}(기대 ${PAGE_SIZE})`);
    const d = dupes(c.ids); if (d.length) problems.push(`페이지 ${i + 1} 응답 안에 중복 id: ${d.join(",")}`);
    const last = i === calls.length - 1;
    if (!last && c.ids.length !== PAGE_SIZE + 1) problems.push(`페이지 ${i + 1}은 ${c.ids.length}행인데 다음 페이지를 요청함(커서는 31행일 때만 생겨야 함)`);
    if (last && c.ids.length === PAGE_SIZE + 1) problems.push(`마지막 응답이 ${PAGE_SIZE + 1}행 — 다음 페이지가 남았는데 로딩이 끝남(누락)`);
    if (!last) {
      const next = calls[i + 1];
      const cursorId = visibleOf(c)[PAGE_SIZE - 1];
      if (next.body.p_before_id !== cursorId) problems.push(`페이지 ${i + 2}의 커서(p_before_id)가 페이지 ${i + 1}의 30번째 행과 다름`);
      if (next.ids[0] !== c.ids[PAGE_SIZE]) problems.push(`페이지 ${i + 2}의 첫 행이 페이지 ${i + 1}의 lookahead(31번째) 행과 다름 — 행 누락/순서 어긋남`);
    }
  });

  const d = dupes(expectedIds); if (d.length) problems.push(`페이지 간 중복 id: ${d.join(",")}`);
  const domDup = dupes(domIds); if (domDup.length) problems.push(`화면에 중복 카드 id: ${domDup.join(",")}`);
  const missing = expectedIds.filter((id) => !domIds.includes(id));
  const extra = domIds.filter((id) => !expectedIds.includes(id));
  if (missing.length) problems.push(`서버가 돌려줬지만 화면에 없는 id ${missing.length}개: ${missing.slice(0, 5).join(",")}`);
  if (extra.length) problems.push(`서버 응답에 없는데 화면에 있는 id ${extra.length}개: ${extra.slice(0, 5).join(",")}`);
  if (!missing.length && !extra.length && JSON.stringify(domIds) !== JSON.stringify(expectedIds)) problems.push("화면 카드 순서가 서버 응답 순서와 다름");
  if (moreButtonVisibleAtEnd) problems.push("모든 페이지 로딩 후에도 '센터 더 보기' 버튼이 남아 있음");
  return verdict();
}

/** 단일 응답 단위 검사: 이 응답이 31행이면 화면에 '더 보기'가 보여야 하고, 30행 이하면 없어야 한다(30/31 경계). */
export function expectedMoreButton(lastCall: PageCall): boolean {
  return lastCall.ids.length > PAGE_SIZE;
}
