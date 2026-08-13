-- ============================================================
-- ROLLBACK for fix_account_search_scope_draft_proposed.sql
--
-- "매니저 계정 검색"/"매니저 대표프로필 검색" 정책을 원래 정의(reservation_functions.sql
-- 기준, 권한 체크 없음)로 복원하고, search_accounts_for_member() RPC를 제거한다.
--
-- ⚠ 이 롤백을 실행하면 SEC-102/103(어디서든 active 매니저이면 accounts/profiles
-- 시스템 전체를 검색 가능)이 다시 열린다. 또한 lib/members.ts가 이미
-- search_accounts_for_member() RPC를 호출하도록 바뀐 상태에서 이 SQL 롤백만
-- 실행하면(코드는 그대로 두고) 회원 등록 검색 기능이 완전히 깨진다 — 코드 변경도
-- 함께 되돌리지 않는 한 이 SQL 롤백만 단독 실행하지 말 것.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

drop function if exists search_accounts_for_member(text);

drop policy if exists "매니저 대표프로필 검색" on profiles;
create policy "매니저 대표프로필 검색"
    on profiles for select
    using (
        is_primary = true
        and exists (
            select 1 from manager_centers mc
            where mc.account_id = my_account_id() and mc.status = 'active'
        )
    );

drop policy if exists "매니저 계정 검색" on accounts;
create policy "매니저 계정 검색"
    on accounts for select
    using (
        exists (
            select 1 from manager_centers mc
            where mc.account_id = my_account_id() and mc.status = 'active'
        )
    );

COMMIT;

-- ============================================================
-- 완료. "매니저 계정 검색"/"매니저 대표프로필 검색" 원래 정의로 복원됨.
-- search_accounts_for_member() RPC는 제거됨.
-- ============================================================
