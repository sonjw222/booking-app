-- Rollback for cleanup_leftover_leads_test_staff_role_2.sql
-- 원래 leftover 행을 동등하게 재생성한다(정확한 원본 UUID는 모름 — 순수 테스트 fixture라
-- get-or-create 패턴상 새 UUID로 재생성돼도 leads.test.ts 동작에는 차이가 없다).
-- TEST_MANAGER_B_EMAIL 계정을 GitHub Actions secret 이름이 아닌 실제 이메일 문자열로
-- 바꿔서 실행해야 한다(예: TEST_MANAGER_B_EMAIL의 실제 값).

BEGIN;

insert into center_roles (center_id, name)
values ('3937eb89-3803-43e9-9a29-e893f779df1a', 'P1-8 테스트 무권한 역할')
on conflict do nothing;

insert into manager_centers (account_id, center_id, role_id, status)
select a.id, '3937eb89-3803-43e9-9a29-e893f779df1a',
       (select id from center_roles
        where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a' and name = 'P1-8 테스트 무권한 역할'),
       'active'
from accounts a
where a.email = 'TEST_MANAGER_B_EMAIL의 실제 값으로 교체'
on conflict do nothing;

COMMIT;
