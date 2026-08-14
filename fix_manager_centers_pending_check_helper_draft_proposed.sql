-- ============================================================
-- "매니저센터 생성" 정책의 centers.status='pending' 체크를 security definer
-- 헬퍼로 감싼다 — raw subquery라 caller(방금 센터를 만든 본인)의 centers SELECT
-- RLS로 평가되는데, centers엔 "본인이 방금 만든 pending 센터"를 볼 수 있는
-- 정책이 없어(created_by 컬럼도 없음) 항상 false가 되어 정상 부트스트랩까지
-- 42501로 막혀 있었다(실측 확인). 조건 자체(centers.status='pending')는 완전히
-- 동일 — 평가 방식만 caller 권한 → 함수 소유자 권한으로 바꾼다.
-- ============================================================

BEGIN;

create or replace function center_is_pending(p_center_id uuid)
returns boolean
language plpgsql stable
security definer
set search_path = public
as $$
begin
    return exists(select 1 from centers where id = p_center_id and status = 'pending');
end;
$$;

drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (
        account_id = my_account_id()
        and role_id is null
        and not manager_centers_has_any_row(center_id)
        and center_is_pending(center_id)
    );

COMMIT;

select policyname, with_check from pg_policies where tablename = 'manager_centers' and policyname = '매니저센터 생성';
