-- ============================================================
-- ⚠️ DEVELOPMENT TEST DATA/PERMISSION FIX ONLY — DO NOT RUN ON PRODUCTION WITHOUT REVIEW ⚠️
--
-- 원인(실제 CI 실행에서 확인, 추측 아님): 새로 만든 tests/e2e/fixtures/testData.ts는
-- getFixtureAdminClient()(service_role key)로 center_settings 테이블을 직접
-- 읽고/쓰려 하는데, CI 로그에 정확히 이렇게 찍혔다:
--
--   Error: 설정을 불러오지 못했어요(admin): permission denied for table center_settings
--
-- 이건 RLS 위반(0건 반환)이 아니라 Postgres GRANT 자체가 없는 것이다 — 이미 이 저장소의
-- tests/integration/sec009-batch-a1-rls.test.ts 파일 헤더 주석에 같은 패턴이 문서화돼
-- 있다("service_role만 GRANT 없음... account_center_permissions에서 이미 겪은 것과
-- 같은 패턴 — 앱 코드가 service_role을 전혀 쓰지 않아 실제 보안과는 무관, 순수하게
-- 테스트 도구(admin client) 제약일 뿐이다"). 그때는 staff_salaries/leads/messages
-- 3개 테이블이 대상이었고 그 테스트는 그 3개를 admin 대신 오너 계정으로 우회했는데,
-- 이번 e2e 스펙은 브라우저 세션과의 충돌(session_not_found, 별도 커밋 참고) 때문에
-- 반드시 admin client로 이 테이블들을 다뤄야 해서 우회할 수 없다.
--
-- 이 파일은 e2e 테스트 픽스처가 admin client로 직접 읽고/쓰는 4개 테이블
-- (center_settings, classes, memberships, reservations)에 service_role GRANT를
-- 추가한다. service_role은 RLS를 완전히 우회하는 키이고 앱 코드(브라우저/서버 어디서도)
-- 이 키를 전혀 쓰지 않으므로(SEC-007에서 이미 확인됨), 이 GRANT는 실제 서비스 보안에는
-- 영향이 없다 — 순수하게 CI/로컬 테스트 도구의 접근 권한 문제다.
--
-- classes/memberships/reservations는 실제로 지금 GRANT가 없는지 확인되지 않았다(이번
-- CI 실행이 center_settings에서 먼저 막혀 거기까지 도달하지 못함) — 혹시 이미 있어도
-- GRANT는 멱등이라(이미 있는 권한을 다시 줘도 에러/부작용 없음) 안전하게 함께 넣는다.
-- ============================================================

BEGIN;

-- 실행 전 확인용(미리보기) — 각 테이블에 대해 service_role의 현재 권한을 확인하세요.
select
    table_name,
    has_table_privilege('service_role', table_name, 'SELECT') as can_select,
    has_table_privilege('service_role', table_name, 'INSERT') as can_insert,
    has_table_privilege('service_role', table_name, 'UPDATE') as can_update,
    has_table_privilege('service_role', table_name, 'DELETE') as can_delete
from (values ('center_settings'), ('classes'), ('memberships'), ('reservations')) as t(table_name);

grant select, insert, update, delete on center_settings to service_role;
grant select, insert, update, delete on classes to service_role;
grant select, insert, update, delete on memberships to service_role;
grant select, insert, update, delete on reservations to service_role;

-- 실행 후 재확인 — 전부 true여야 정상.
select
    table_name,
    has_table_privilege('service_role', table_name, 'SELECT') as can_select,
    has_table_privilege('service_role', table_name, 'INSERT') as can_insert,
    has_table_privilege('service_role', table_name, 'UPDATE') as can_update,
    has_table_privilege('service_role', table_name, 'DELETE') as can_delete
from (values ('center_settings'), ('classes'), ('memberships'), ('reservations')) as t(table_name);

COMMIT;
-- 문제가 발견되면 위 COMMIT 대신 ROLLBACK을 실행하세요.
