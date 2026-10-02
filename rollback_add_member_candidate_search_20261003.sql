-- add_member_candidate_search_20261003.sql가 바꾼 것만 되돌린다: 새 RPC 제거 + 기존 search_accounts_for_member(text)의 authenticated 실행 권한 복원(직전 Production 상태: authenticated 가능, anon/PUBLIC 불가).
-- 주의: 새 웹(search_member_candidates 호출)이 배포된 상태에서 이 rollback만 실행하면 회원 추가 검색이 "함수 없음" 오류로 실패한다 — 웹을 먼저 되돌리세요.
begin;
drop function if exists public.search_member_candidates(uuid, text);
do $$
begin
    if to_regprocedure('public.search_accounts_for_member(text)') is not null then
        execute 'grant execute on function public.search_accounts_for_member(text) to authenticated';
    end if;
end $$;
commit;
