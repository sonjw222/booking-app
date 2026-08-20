-- Rollback for cleanup_leftover_leads_test_staff_role.sql
-- 원래 leftover 행들을 그대로 복원한다(테스트 데이터라 실질적 의미는 없음).

BEGIN;

insert into center_roles (id, center_id, name)
values ('f352b272-8356-45be-8616-850a97290355', '3937eb89-3803-43e9-9a29-e893f779df1a', 'P1-8 테스트 무권한 역할')
on conflict (id) do nothing;

insert into manager_centers (id, account_id, center_id, role_id, status)
values ('f92eb4e3-f0dd-447e-984f-7bf06a5e155d', '47057f26-c280-4b82-8feb-cd893440e2ee', '3937eb89-3803-43e9-9a29-e893f779df1a', 'f352b272-8356-45be-8616-850a97290355', 'active')
on conflict (id) do nothing;

COMMIT;
