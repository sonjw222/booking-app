-- ============================================================
-- my_account_id() 수정 — 병합된(merged_into) 계정이 여전히 자기 자신의 id를 반환하던 버그
--
-- 배경: add_account_linking.sql의 my_account_id()는
--   coalesce(
--     (select id from accounts where auth_id = auth.uid()),          -- 1차
--     (select account_id from account_auth_identities where ...)     -- 2차(fallback)
--   )
-- 였는데, B(합쳐진 계정)의 accounts 행은 병합 후에도 삭제되지 않고 auth_id도 그대로라
-- 1차 조건이 항상 먼저 매칭돼버려서 B가 재로그인해도 계속 B 자신의 (이제는 비어있는)
-- accountId를 반환했다 — "다른 계정과 연결" 실제 왕복 테스트(2026-09-09) 중
-- "프로필이 없어요" 오류로 재현 확인.
--
-- 수정: 1차 조회에서 찾은 계정이 merged_into가 설정돼 있으면 그 병합 대상 id를 대신
-- 반환한다.
--
-- DB 재생성 불필요. 여러 번 실행해도 안전(create or replace).
-- ============================================================

create or replace function my_account_id()
returns uuid
language sql stable
security definer
set search_path = public
as $$
    -- security definer: 정책 안에서 이 함수를 호출해도 accounts RLS를 다시
    --   타지 않게 함 (그렇지 않으면 accounts 조회 정책 ↔ 이 함수 사이 무한 재귀)
    select coalesce(
        (select coalesce(merged_into, id) from accounts where auth_id = auth.uid()),
        (select account_id from account_auth_identities where auth_id = auth.uid())
    );
$$;
