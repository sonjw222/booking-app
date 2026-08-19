-- ============================================================
-- SEC-101/112/114/115/116/117 적용 직전 Live baseline 진단 — 100% READ-ONLY.
-- SELECT / pg_get_functiondef / pg_get_triggerdef / information_schema /
-- pg_proc / pg_policies / has_function_privilege / has_schema_privilege만
-- 사용한다. CREATE/ALTER/DROP/GRANT/REVOKE 없음 — 이 파일 실행만으로는
-- 아무것도 바뀌지 않는다.
--
-- 전체를 한 번에 SQL Editor에 붙여넣고 실행하면 각 SELECT의 결과가 순서대로
-- 나온다. 결과 전체를 이 대화에 다시 붙여넣어 주시면 draft SQL의 "Before"
-- 가정과 정확히 일치하는지 확정 보고하겠습니다.
-- ============================================================

-- ------------------------------------------------------------
-- A. manager_centers 현재 Live 정책 전문(SEC-101/112 대상)
-- ------------------------------------------------------------
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where tablename = 'manager_centers'
order by policyname, cmd;

-- A-2. [2026-08-13 추가] center_roles의 현재 SELECT 정책 — SEC-101/112 새 WITH CHECK가
-- "select id from center_roles where center_id=..." 서브쿼리를 쓰므로, center_roles의
-- 자체 RLS 정책이 manager_centers를 다시 참조해 순환(2-hop: manager_centers UPDATE
-- WITH CHECK → center_roles SELECT policy → manager_centers SELECT policy)이 발생해도
-- Postgres RLS 자체 순환 오류("infinite recursion detected in policy")로 이어지지
-- 않는지 사전 확인용. has_permission()이 이미 동일한 manager_centers⋈center_roles
-- 조인 패턴을 정책 표현식 안에서 광범위하게 쓰고 있어(요청받은 함수 대부분의 권한
-- 체크) 실제로는 이미 검증된 패턴으로 판단하지만, 실행 전 실측 확인 권장.
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where tablename = 'center_roles'
order by policyname, cmd;

-- ------------------------------------------------------------
-- B. auto_book_membership(uuid) 현재 Live 함수 본문(SEC-114 대상)
-- ------------------------------------------------------------
select pg_get_functiondef('auto_book_membership(uuid)'::regprocedure);

-- ------------------------------------------------------------
-- C. manager_set_attendance(uuid,text) 현재 Live 함수 본문(SEC-115 대상)
-- ------------------------------------------------------------
select pg_get_functiondef('manager_set_attendance(uuid, text)'::regprocedure);

-- ------------------------------------------------------------
-- D. SEC-116/117 하드닝 대상 함수들의 SECURITY DEFINER 여부 / owner /
--    search_path(proconfig) / EXECUTE privilege 현재 상태
-- ------------------------------------------------------------
select
    p.proname                                   as function_name,
    pg_get_function_identity_arguments(p.oid)   as args,
    case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security_type,
    r.rolname                                    as owner,
    p.proconfig                                  as proconfig  -- search_path 설정 여기 표시됨(없으면 null)
from pg_proc p
join pg_roles r on r.oid = p.proowner
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
      'auto_book_membership', 'manager_set_attendance',
      'reserve_class', 'reserve_with_membership', 'cancel_reservation',
      'refund_membership', 'fulfill_order', 'usable_memberships',
      'usable_memberships_for_classes', 'is_platform_admin'
  )
order by p.proname;

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
      'auto_book_membership', 'manager_set_attendance',
      'reserve_class', 'reserve_with_membership', 'cancel_reservation',
      'refund_membership', 'fulfill_order', 'usable_memberships',
      'usable_memberships_for_classes', 'is_platform_admin'
  )
order by routine_name, grantee;

-- has_function_privilege로 PUBLIC/anon/authenticated 각각 명시 확인(위 결과 교차검증용)
select
    'auto_book_membership(uuid)' as fn,
    has_function_privilege('anon', 'auto_book_membership(uuid)', 'EXECUTE') as anon_can_execute,
    has_function_privilege('authenticated', 'auto_book_membership(uuid)', 'EXECUTE') as authenticated_can_execute
union all
select 'manager_set_attendance(uuid,text)',
    has_function_privilege('anon', 'manager_set_attendance(uuid,text)', 'EXECUTE'),
    has_function_privilege('authenticated', 'manager_set_attendance(uuid,text)', 'EXECUTE')
union all
select 'reserve_class(uuid,uuid)',
    has_function_privilege('anon', 'reserve_class(uuid,uuid)', 'EXECUTE'),
    has_function_privilege('authenticated', 'reserve_class(uuid,uuid)', 'EXECUTE')
union all
select 'reserve_with_membership(uuid,uuid,uuid)',
    has_function_privilege('anon', 'reserve_with_membership(uuid,uuid,uuid)', 'EXECUTE'),
    has_function_privilege('authenticated', 'reserve_with_membership(uuid,uuid,uuid)', 'EXECUTE')
union all
select 'cancel_reservation(uuid)',
    has_function_privilege('anon', 'cancel_reservation(uuid)', 'EXECUTE'),
    has_function_privilege('authenticated', 'cancel_reservation(uuid)', 'EXECUTE')
union all
select 'refund_membership(uuid)',
    has_function_privilege('anon', 'refund_membership(uuid)', 'EXECUTE'),
    has_function_privilege('authenticated', 'refund_membership(uuid)', 'EXECUTE')
union all
select 'fulfill_order(uuid)',
    has_function_privilege('anon', 'fulfill_order(uuid)', 'EXECUTE'),
    has_function_privilege('authenticated', 'fulfill_order(uuid)', 'EXECUTE')
union all
select 'usable_memberships(uuid,uuid)',
    has_function_privilege('anon', 'usable_memberships(uuid,uuid)', 'EXECUTE'),
    has_function_privilege('authenticated', 'usable_memberships(uuid,uuid)', 'EXECUTE')
union all
select 'usable_memberships_for_classes(uuid[],uuid)',
    has_function_privilege('anon', 'usable_memberships_for_classes(uuid[],uuid)', 'EXECUTE'),
    has_function_privilege('authenticated', 'usable_memberships_for_classes(uuid[],uuid)', 'EXECUTE')
union all
select 'is_platform_admin()',
    has_function_privilege('anon', 'is_platform_admin()', 'EXECUTE'),
    has_function_privilege('authenticated', 'is_platform_admin()', 'EXECUTE');

-- ------------------------------------------------------------
-- D-2. [2026-08-13 추가, SEC-114 필수 사전 확인] 'schedule.own.group.booking' 권한이
-- 실제 운영 센터의 owner 아닌 role(manager/trainer)에 얼마나 부여돼 있는지.
-- create_default_center_roles()는 owner/manager/trainer 3개 role만 만들고
-- role_permissions은 전혀 채우지 않는다(schema.sql 1263행 확인) — 즉 manager/trainer는
-- 기본값으로 이 권한이 없다. "미배치 수강권 재시도" 화면은 현재 어떤 permission
-- key로도 UI에서 가리지 않으므로(app/manager/classes/page.tsx 확인), 만약 실제
-- 운영 센터에 이 권한 없이 재시도 버튼을 쓰는 non-owner staff가 있다면 SEC-114
-- 적용 후 그 사람만 권한 오류를 받는다(owner는 is_owner bypass로 항상 통과).
-- 아래 결과가 0행이면(= 전 센터 owner만 이 기능을 쓰고 있었다는 뜻이거나, 아직
-- 아무도 명시적으로 이 권한을 부여받은 적 없다는 뜻) 회귀 위험 낮음으로 판단.
-- 0행이 아니면 그 account/center 목록을 보여주시면 실제 영향 범위를 확정하겠습니다.
select
    rp.role_id, cr.center_id, cr.name as role_name, cr.is_owner
from role_permissions rp
join center_roles cr on cr.id = rp.role_id
where rp.permission_key = 'schedule.own.group.booking';

select
    acp.manager_center_id, mc.account_id, mc.center_id, acp.grant_type
from account_center_permissions acp
join manager_centers mc on mc.id = acp.manager_center_id
where acp.permission_key = 'schedule.own.group.booking';

-- ------------------------------------------------------------
-- E. create_default_center_roles()의 실제 Live security 속성
--    (SEC-101/112 부트스트랩 트리거 — 이번 배치는 이 함수를 수정하지 않지만,
--    manager_centers 정책 변경이 이 트리거의 전제와 어긋나지 않는지 확인용)
-- ------------------------------------------------------------
select pg_get_functiondef('create_default_center_roles()'::regprocedure);
select pg_get_triggerdef(oid)
from pg_trigger
where tgname = 'trg_create_default_center_roles' and not tgisinternal;

-- ------------------------------------------------------------
-- F. anon/authenticated가 public 스키마에 CREATE 권한을 갖는지
--    (search_path hijack 가능성 최종 확인 — SEC-117)
-- ------------------------------------------------------------
select has_schema_privilege('anon', 'public', 'create')          as anon_can_create_in_public;
select has_schema_privilege('authenticated', 'public', 'create') as authenticated_can_create_in_public;

-- ------------------------------------------------------------
-- G. 적용 대상 함수 signature가 draft SQL과 정확히 일치하는지(개수/타입 확인용)
-- ------------------------------------------------------------
select
    p.proname as function_name,
    pg_get_function_arguments(p.oid) as full_signature
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
      'auto_book_membership', 'manager_set_attendance',
      'reserve_class', 'reserve_with_membership', 'cancel_reservation',
      'refund_membership', 'fulfill_order', 'usable_memberships',
      'usable_memberships_for_classes'
  )
order by p.proname;

-- ------------------------------------------------------------
-- H. [2026-08-14 추가] reservations.membership_consumed 컬럼 기본값 확인(SEC-115
-- 관련 별도 항목 — reserve_class()가 이 컬럼을 명시적으로 채우지 않아 컬럼 기본값을
-- 그대로 물려받는다는 Git 근거를 Live에서 재확인. 이번 배치의 SEC-115 fix 자체는
-- membership_consumed가 아니라 status를 기준으로 삼으므로 이 결과와 무관하게
-- 안전하지만, 별도 후속 이슈로 기록하기 위해 확정 필요).
select column_name, column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'reservations' and column_name = 'membership_consumed';

