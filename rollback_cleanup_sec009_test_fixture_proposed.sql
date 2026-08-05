-- ============================================================
-- ⚠️ DEVELOPMENT TEST DATA ROLLBACK ONLY — DO NOT RUN ON PRODUCTION ⚠️
-- cleanup_sec009_test_fixture_proposed.sql이 지운 role + manager_centers를 동일한
-- 특성(같은 센터, 같은 계정, 같은 역할명, status='active', is_owner=false)으로 다시
-- 만든다. 원래 행의 정확한 id(uuid)까지 복원하지는 않는다 — 이 데이터는 실제 업무 데이터가
-- 아니라 테스트 픽스처이므로, id가 달라져도 기능적으로 동일하다.
--
-- ⚠️ 계정 이메일 규칙을 추측하지 않기 위해, centerA/MANAGER_B의 id를 하드코딩 추측 대신
-- 아래 두 변수에 직접 채워 넣도록 했습니다 — 이전에 실행하신 진단 쿼리 [1]의 결과에서
-- role_name='SEC-009 Batch A1 테스트 무권한 역할'이었던 행의 center_id와 account_id를
-- 그대로 복사해 넣으시면 됩니다(그 값이 정확히 이 역할이 속해 있던 센터/계정입니다).
--
-- ⚠️ 주의: cleanup 실행과 이 롤백 사이에 sec009-batch-a1-rls.test.ts가 다시 실행되어
-- get-or-create로 스스로 role/manager_centers를 재생성했다면, 이 롤백은 불필요하거나
-- 중복 행을 만들 수 있다 — 아래 미리보기로 이미 존재하는지 먼저 확인할 것.
-- ============================================================

BEGIN;

-- ▼▼▼ 진단 쿼리 [1] 결과에서 복사해 채워 넣으세요 ▼▼▼
-- select 'REPLACE_WITH_CENTER_ID'::uuid as center_id, 'REPLACE_WITH_ACCOUNT_ID'::uuid as account_id
-- \gset  -- (psql 사용 시. Supabase SQL Editor에서는 아래 do 블록 안의 상수를 직접 교체하세요)

-- 미리보기 — 이미 같은 이름의 role이 있으면(테스트가 재실행되어 스스로 재생성한 경우)
-- 아래 INSERT를 실행하면 안 된다. 0건이어야 계속 진행.
select id, center_id, is_owner from center_roles
where name = 'SEC-009 Batch A1 테스트 무권한 역할' and is_owner = false;

do $$
declare
    -- ⚠️ 아래 두 줄을 진단 쿼리 [1] 결과의 실제 값으로 반드시 교체한 뒤 실행하세요.
    v_center_id  uuid := 'REPLACE_WITH_CENTER_ID';   -- 예: '11111111-1111-1111-1111-111111111111'
    v_account_id uuid := 'REPLACE_WITH_ACCOUNT_ID';  -- MANAGER_B(test-manager-b@example.com)의 account_id
    v_role_id    uuid;
    v_existing_count int;
begin
    select count(*) into v_existing_count
    from center_roles where name = 'SEC-009 Batch A1 테스트 무권한 역할' and is_owner = false;
    if v_existing_count > 0 then
        raise exception '이미 같은 이름의 역할이 %건 존재합니다 — 중복 생성을 막기 위해 중단합니다. '
            '이 경우 롤백이 필요 없는 상태(테스트가 이미 스스로 재생성함)일 가능성이 높습니다.', v_existing_count;
    end if;

    if not exists (select 1 from centers where id = v_center_id) then
        raise exception 'v_center_id(%)에 해당하는 센터가 없습니다 — 값을 다시 확인하세요.', v_center_id;
    end if;
    if not exists (select 1 from accounts where id = v_account_id) then
        raise exception 'v_account_id(%)에 해당하는 계정이 없습니다 — 값을 다시 확인하세요.', v_account_id;
    end if;

    -- 역할 재생성
    insert into center_roles (center_id, name, is_owner)
    values (v_center_id, 'SEC-009 Batch A1 테스트 무권한 역할', false)
    returning id into v_role_id;

    -- manager_centers 재생성(무권한 스태프로, active)
    insert into manager_centers (center_id, account_id, role_id, status)
    values (v_center_id, v_account_id, v_role_id, 'active');
end $$;

COMMIT;
-- 문제가 발견되면 위 COMMIT 대신 ROLLBACK을 실행하세요.
