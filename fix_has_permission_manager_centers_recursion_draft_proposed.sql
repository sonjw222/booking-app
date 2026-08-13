-- ============================================================
-- HOTFIX v2(P0, Live 재현 확인됨): has_permission()도 재귀 경로였음
--   fix_center_roles_manager_centers_recursion_draft_proposed.sql 단독 적용 후에도
--   "스태프 추가에 실패했어요: infinite recursion detected in policy for relation
--   manager_centers"가 계속 재현됨(사용자 실측 확인, 2026-08-13).
--
-- [근본 원인 2]
--   has_permission(p_center_id, p_permission)이 SECURITY DEFINER가 아니라 caller
--   권한으로 manager_centers/center_roles를 raw JOIN한다(reservation_functions.sql:31-):
--     from manager_centers mc join center_roles r on r.id = mc.role_id
--     where mc.account_id = my_account_id() and mc.center_id = p_center_id and mc.status='active'
--   이 함수는 "오너 스태프 초대"/"오너 스태프 수정" 정책(manager_centers 자신에 대한
--   INSERT/UPDATE WITH CHECK) 안에서 호출된다. 즉 manager_centers에 쓰기 시도 →
--   해당 정책이 has_permission() 호출 → 그 안에서 다시 manager_centers를 raw 조회 →
--   순환. center_roles 쪽 정책만 고쳐서는 이 경로가 남아 있었다.
--
-- [고친 것] has_permission()에 security definer + search_path 고정 추가 — 로직/
--   반환값/시그니처는 전혀 바꾸지 않는다. my_managed_center_ids()가 이미 쓰고 있는
--   것과 동일한, 검증된 패턴(내부 쿼리가 테이블 소유자 권한으로 실행돼 RLS를 다시
--   타지 않음).
--
-- [영향 범위] has_permission()은 manager_centers 외 다른 테이블 정책에서도 널리
--   쓰이지만(reservation_functions.sql 전역), 반환값/판정 로직이 그대로이므로 다른
--   곳의 동작에는 영향이 없다 — "누가 호출하든 항상 같은 답을 준다"는 성질 자체가
--   security definer로의 전환과 완전히 양립한다(my_account_id()로 caller 식별은
--   함수 안에서 그대로 하므로 caller별 결과가 여전히 다르게 나옴, 단지 그 계산에
--   필요한 내부 조회가 RLS를 다시 타지 않을 뿐).
--
-- [영향받는 기존 데이터] 없음(함수 재정의만).
-- [위험도] 낮음 — 이미 저장소 전체에서 검증된 동일 패턴 재사용.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace function has_permission(p_center_id uuid, p_permission text)
returns boolean
language sql stable
security definer
set search_path = public
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

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select routine_name, security_type from information_schema.routines where routine_name = 'has_permission';
-- 적용 후 /manager/staff에서 스태프 초대 다시 시도.
