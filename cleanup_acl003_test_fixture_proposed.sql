-- ============================================================
-- ⚠️ DEVELOPMENT TEST DATA CLEANUP ONLY — DO NOT RUN ON PRODUCTION ⚠️
--
-- TEST-002 조사에서 확인된, acl-003-permission-read.test.ts(PR #19)의 beforeAll이
-- afterAll cleanup 없이 개발용(통합 테스트 대상) Supabase 프로젝트에 영구히 남긴
-- fixture 데이터를 정리하는 일회성 스크립트입니다.
--
-- 이 파일은 초안(PROPOSED)이며, 아래 순서를 반드시 지킨 뒤에만 실행하세요.
--   1) "미리보기" SELECT 결과(아래 STEP 1, STEP 3)를 먼저 직접 확인
--   2) 예상 행 수(STEP 1 = 1건, STEP 3 = 2건)와 실제가 다르면 절대 진행하지 말고 ROLLBACK
--   3) 사용자의 명시적 실행 승인
--   4) 실행 대상은 "현재 통합 테스트가 쓰는 개발용 Supabase 프로젝트"뿐입니다 — 운영
--      프로젝트가 별도로 생기면 그 URL에는 이 파일을 절대 실행하지 마세요
--      (tests/integration/loadEnv.ts의 PRODUCTION_SUPABASE_URL 가드와 동일한 원칙).
--
-- 대상 식별 방식: 이메일 문자열이 아니라 아래 세 가지를 함께 검증합니다.
--   - center_roles.name = 'ACL-003 테스트 무권한 역할' AND is_owner = false
--     (acl-003-permission-read.test.ts의 getOrCreateNoPermRole()이 정확히 이 문자열로만
--      생성하므로, 이 이름을 가진 역할이 있다면 그 자체가 이 테스트의 산출물입니다.
--      center_roles.name은 센터별로만 유일하면 되므로 이론상 다른 센터에 같은 이름의
--      역할이 있을 수 있지만, 이 문구를 실제 운영자가 우연히 만들 가능성은 사실상 없고,
--      아래 DO 블록이 "이 역할을 쓰는 manager_centers가 정확히 1건"임을 다시 검증합니다)
--   - 그 역할을 실제로 쓰는 manager_centers 행(정확히 1건이어야 함 — 다르면 중단)
--   - 같은 센터의 "오너" manager_center_id에 남은 permission_key='customer.member.view'
--     override(ACL-003 테스트가 오너 자신의 행에도 override를 하나 남겼음)
--
-- FK 관계(schema.sql / add_personal_permissions.sql 확인됨):
--   account_center_permissions.manager_center_id → manager_centers(id) ON DELETE CASCADE
--   manager_centers.role_id → center_roles(id)  (ON DELETE 절 없음 = NO ACTION/RESTRICT)
--   → manager_centers를 먼저 지워야 center_roles를 지울 수 있습니다. 순서를 바꾸면
--     FK violation으로 트랜잭션 전체가 자동 실패합니다(그 자체로 안전장치이기도 합니다).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- STEP 1. 삭제 대상 역할/manager_centers 행을 임시 테이블에 고정
--         (이후 모든 단계가 정확히 같은 대상만 참조하도록 하기 위함)
-- ------------------------------------------------------------
create temporary table acl003_cleanup_targets on commit drop as
select
    cr.id as role_id,
    cr.center_id,
    mc.id as manager_center_id,
    mc.account_id as staff_account_id,
    mc.status as staff_status
from center_roles cr
join manager_centers mc on mc.role_id = cr.id
where cr.name = 'ACL-003 테스트 무권한 역할'
  and cr.is_owner = false;

-- 미리보기 — 실행 전 반드시 직접 확인하세요. 예상: 정확히 1행.
select * from acl003_cleanup_targets;

-- STEP 1 검증: 정확히 1건이 아니면 여기서 즉시 중단(예외 발생 → 트랜잭션 실패 → 자동 rollback).
do $$
declare
    v_count int;
begin
    select count(*) into v_count from acl003_cleanup_targets;
    if v_count <> 1 then
        raise exception
            'acl003_cleanup_targets 행 수가 예상(1)과 다릅니다: %건. '
            '0건이면 이미 정리된 상태이고, 2건 이상이면 예상치 못한 다른 데이터가 섞여 있는 것이니 '
            '여기서 중단합니다(COMMIT하지 말고 ROLLBACK하세요).', v_count;
    end if;
end $$;

-- ------------------------------------------------------------
-- STEP 2. 정리 대상 개인 권한 예외(account_center_permissions) 식별
--         (스태프 자신의 행 + 같은 센터 "오너" 자신의 행, 둘 다 permission_key가
--          정확히 customer.member.view인 것만 — 다른 권한 키는 절대 건드리지 않음)
-- ------------------------------------------------------------
create temporary table acl003_cleanup_perms on commit drop as
select acp.id
from account_center_permissions acp
where acp.permission_key = 'customer.member.view'
  and (
        acp.manager_center_id in (select manager_center_id from acl003_cleanup_targets)
        or acp.manager_center_id in (
            select mc.id
            from manager_centers mc
            join center_roles cr on cr.id = mc.role_id and cr.is_owner = true
            where mc.center_id in (select center_id from acl003_cleanup_targets)
        )
      );

-- 미리보기 — 실행 전 반드시 직접 확인하세요. 예상: 정확히 2행
-- (스태프 자신의 override 1건 + 오너 자신의 override 1건).
select * from acl003_cleanup_perms;

-- STEP 2 검증
do $$
declare
    v_count int;
begin
    select count(*) into v_count from acl003_cleanup_perms;
    if v_count <> 2 then
        raise exception
            'acl003_cleanup_perms 행 수가 예상(2)과 다릅니다: %건. 여기서 중단합니다 '
            '(COMMIT하지 말고 ROLLBACK하세요).', v_count;
    end if;
end $$;

-- ------------------------------------------------------------
-- STEP 3. 삭제 — 자식(account_center_permissions) → manager_centers → center_roles 순서
--         (manager_centers를 지우면 그 행에 딸린 account_center_permissions는 FK
--          CASCADE로 자동 삭제되지만, 오너 자신의 override 행은 별도 manager_center_id라
--          CASCADE 대상이 아니므로 아래 명시적 DELETE가 반드시 필요함)
-- ------------------------------------------------------------
delete from account_center_permissions
where id in (select id from acl003_cleanup_perms);

delete from manager_centers
where id in (select manager_center_id from acl003_cleanup_targets);

delete from center_roles
where id in (select role_id from acl003_cleanup_targets);

-- 위 세 DELETE의 실제 삭제 건수를 psql/Supabase SQL Editor 결과 메시지에서 확인하세요
-- (account_center_permissions 2건, manager_centers 1건, center_roles 1건이어야 정상).

commit;
-- 문제가 발견되면 위 commit 대신 rollback; 을 실행하세요.
