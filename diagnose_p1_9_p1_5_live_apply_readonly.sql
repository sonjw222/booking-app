-- ============================================================
-- 읽기 전용 진단: add_admin_assignment_permission_gate.sql /
-- add_manager_menu_permissions.sql이 실제로 라이브에 적용됐는지 확인
--
-- 아무것도 바꾸지 않습니다 — 그냥 조회만 합니다.
-- ============================================================

-- [1] can_manage_center_reservations()의 실제 본문.
-- 아래에 'schedule.makeup'이 보이면 add_admin_assignment_permission_gate.sql이
-- 적용된 것이고, 안 보이면(예: manager_centers/status='active'만 확인하는 옛 본문이면)
-- 아직 미적용입니다.
select pg_get_functiondef('can_manage_center_reservations(uuid)'::regprocedure);

-- [2] add_manager_menu_permissions.sql이 새로 추가하는 두 permission key가
-- 카탈로그에 있는지. 두 행 다 나오면 적용된 것입니다.
select key, label
  from permissions
 where key in ('pass.goods.view', 'schedule.admin_assignment_log.view');
