-- ============================================================
-- SEC-101+SEC-112(v2) + RLS 재귀 hotfix(v3 helper 함수) 통합 최종본
-- [2026-08-13] v1(center_roles)/v2(has_permission SECURITY DEFINER) 적용 후에도
-- manager_centers INSERT가 "infinite recursion detected in policy for relation
-- manager_centers"로 계속 재현됨(실측 확인) — 남은 원인은 manager_centers 자체
-- INSERT 정책들의 raw self/cross 서브쿼리(security definer 함수로 안 감싸짐).
-- 다른 세션의 fix_manager_centers_self_reference_recursion_draft_proposed.sql(v3)
-- 설계를 그대로 채택하되, "매니저센터 생성"에는 내가 추가한 orphan(approved) 센터
-- self-claim 차단(centers.status='pending' 체크)을 유지 결합한다. 그 외 로직/조건은
-- v3와 완전히 동일 — 표현 방식(raw subquery → security definer 함수 호출)만 다름.
-- ============================================================

BEGIN;

-- [1] helper 함수 3종(다른 세션 v3와 동일 — role_id/center_id 정합성 판정을
-- security definer로 감싸 RLS 재귀 경로 자체를 구조적으로 제거)
create or replace function manager_centers_has_any_row(p_center_id uuid, p_exclude_id uuid default null)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists(
        select 1 from manager_centers
        where center_id = p_center_id
          and (p_exclude_id is null or id <> p_exclude_id)
    );
$$;

create or replace function role_id_belongs_to_center(p_role_id uuid, p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists(
        select 1 from center_roles where id = p_role_id and center_id = p_center_id
    );
$$;

create or replace function role_id_is_owner_for_center(p_role_id uuid, p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists(
        select 1 from center_roles where id = p_role_id and center_id = p_center_id and is_owner = true
    );
$$;

-- [2] INSERT "매니저센터 생성" — SEC-101 self-join 차단 + orphan(approved) 센터
-- self-claim 차단(centers.status='pending') 유지, self-subquery는 함수로 치환
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

-- [3] INSERT "오너 스태프 초대"
drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (
        has_permission(center_id, 'facility.staff.create')
        and (
            role_id is null
            or role_id_belongs_to_center(role_id, center_id)
        )
    );

-- [4] UPDATE "오너 스태프 수정" — SEC-112(null-role 초대 self-promote 차단 포함)
drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (
        (
            account_id = my_account_id()
            and role_id is null
            and not manager_centers_has_any_row(center_id, id)
        )
        or has_permission(center_id, 'facility.staff.update')
    )
    with check (
        (
            role_id is null
            or role_id_belongs_to_center(role_id, center_id)
        )
        and (
            (
                account_id = my_account_id()
                and status = 'active'
                and role_id_is_owner_for_center(role_id, center_id)
            )
            or has_permission(center_id, 'facility.staff.update')
        )
    );

-- [5] DELETE "오너 스태프 삭제" — 다른 세션의 SEC-113(마지막 행 self-delete 방지) 그대로 유지
drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (
        (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'))
        and manager_centers_has_any_row(center_id, id)
    );

COMMIT;

select tablename, policyname, cmd, qual, with_check
from pg_policies where tablename = 'manager_centers' order by cmd, policyname;
