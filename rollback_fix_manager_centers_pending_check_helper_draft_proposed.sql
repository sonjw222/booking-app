-- ============================================================
-- fix_manager_centers_pending_check_helper_draft_proposed.sql 롤백
--
-- "매니저센터 생성" 정책의 centers.status='pending' 체크를 center_is_pending() 헬퍼
-- 이전의 raw subquery 형태로 되돌린다(fix_manager_centers_privilege_escalation_draft_
-- proposed.sql의 원래 [2] 블록과 동일한 조건 — 표현 방식만 되돌림). ⚠ 이 롤백을 적용하면
-- "정상적으로 방금 만든 pending 센터를 스스로 부트스트랩하는 흐름"이 다시 42501로
-- 막힌다(이 헬퍼를 만든 이유 자체가 그 버그를 고치는 것이었음) — 회귀 테스트가 실제로
-- 이 헬퍼 때문에 실패하는 것으로 확인된 경우에만 사용할 것.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (
        account_id = my_account_id()
        and role_id is null
        and not manager_centers_has_any_row(center_id)
        and exists (
            select 1 from centers c
            where c.id = manager_centers.center_id and c.status = 'pending'
        )
    );

drop function if exists center_is_pending(uuid);

COMMIT;

-- ============================================================
-- 완료. "매니저센터 생성" 정책이 center_is_pending() 헬퍼 적용 이전 조건으로 복원됨.
-- ============================================================
