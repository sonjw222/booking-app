-- ============================================================
-- ROLLBACK for fix_manager_centers_privilege_model_draft_proposed.sql (2026-08-13 재조정판)
--
-- add_staff_permissions.sql의 원래(2026-07-26 초기 스냅샷) 4개 정책으로 정확히 복원하고,
-- 신규 trigger/helper 함수 3종을 제거하고, has_permission()을 security definer/join
-- 조건 없는 원래 정의로 되돌리고, center_roles "내 센터 역할 조회" 정책도 원래의 raw
-- manager_centers 서브쿼리로 되돌린다.
--
-- ⚠⚠⚠ 매우 중요 — 이 롤백을 실행하면 2026-08-13에 사용자가 Live에 적용·실측 확인한
-- RLS 무한 재귀 hotfix 3종(center_roles/has_permission/manager_centers 자기참조,
-- fix_center_roles_manager_centers_recursion_draft_proposed.sql 등 3개 파일)이 전부
-- 원상복구되어 **"스태프 추가에 실패했어요: infinite recursion detected in policy for
-- relation manager_centers" 버그가 다시 재현된다.** 스태프 초대 기능이 다시 완전히
-- 깨진다는 뜻이다.
--
-- 이 롤백은 SEC-101(임의 센터 self-join)/SEC-112(self-promote)/SEC-113(마지막 행
-- self-delete → orphan → 재클레임)/RLS 무한 재귀 hotfix 3종/has_permission()
-- defense-in-depth를 전부 그대로 되돌린다. 회귀 테스트가 실제로 이 배치 때문에
-- 실패하는 것으로 확인된 경우에만, 그리고 근본 원인을 먼저 규명한 뒤에만 사용할 것.
-- 정말로 필요한 경우가 아니면 이 파일 전체 대신 개별 hotfix 파일의 개별 rollback
-- (rollback_fix_center_roles_manager_centers_recursion_draft_proposed.sql 등)을
-- 검토할 것.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

drop trigger if exists trg_manager_centers_role_center_match on manager_centers;
drop function if exists manager_centers_enforce_role_center_match();

drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (account_id = my_account_id());

drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (has_permission(center_id, 'facility.staff.create'));

drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (account_id = my_account_id() or has_permission(center_id, 'facility.staff.update'))
    with check (account_id = my_account_id() or has_permission(center_id, 'facility.staff.update'));

drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'));

-- hotfix v3가 추가한 helper 함수 3종 제거(위 정책들이 더 이상 이 함수들을 쓰지 않으므로 안전)
drop function if exists manager_centers_has_any_row(uuid, uuid);
drop function if exists role_id_belongs_to_center(uuid, uuid);
drop function if exists role_id_is_owner_for_center(uuid, uuid);

-- has_permission()을 security definer/cross-center join 조건 전부 없는 원래 정의로 복원
create or replace function has_permission(p_center_id uuid, p_permission text)
returns boolean
language sql stable
as $$
    with me as (
        select mc.id as mc_id, r.is_owner, mc.role_id
        from manager_centers mc
        join center_roles r on r.id = mc.role_id
        where mc.account_id = my_account_id()
          and mc.center_id = p_center_id
          and mc.status = 'active'
        limit 1
    )
    select coalesce((
        select
            case
                when m.is_owner then true
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'deny'
                ) then false
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'allow'
                ) then true
                when exists (
                    select 1 from role_permissions rp
                    where rp.role_id = m.role_id
                      and rp.permission_key = p_permission
                ) then true
                else false
            end
        from me m
    ), false);
$$;

drop policy if exists "내 센터 역할 조회" on center_roles;
create policy "내 센터 역할 조회"
    on center_roles for select
    using (center_id in (select center_id from manager_centers where account_id = my_account_id()));

COMMIT;

-- ============================================================
-- 완료. add_staff_permissions.sql 원본 4개 정책 + 원래 has_permission() 정의 +
-- 원래 center_roles "내 센터 역할 조회" 정책(raw 서브쿼리)으로 정확히 복원됨.
-- 신규 trigger·helper 함수 3종은 제거됨.
-- ⚠ 이 상태는 RLS 무한 재귀 버그가 있는 상태다 — 스태프 초대가 다시 깨진다.
-- ============================================================
