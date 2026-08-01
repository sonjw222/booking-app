-- ============================================================
-- ⚠️ 초안(DRAFT) / 제안(PROPOSED) — 실행 금지(DO NOT RUN) ⚠️
--
-- ACL-003 서버 측 권한 재검증(2026-08-01)에서 발견한 FAIL을 수정하는 초안입니다.
-- 사용자 승인 없이 운영 Supabase에 절대 실행하지 마세요. 실행 전 반드시:
--   1) 스테이징/로컬 Supabase에서 먼저 적용
--   2) tests/integration/acl-003-permission-read.test.ts를 통과시킴
--      (이 테스트는 현재 정책 기준으로는 실패하도록 작성되어 있고, 이 SQL을
--       적용한 뒤에만 통과해야 합니다 — 통과하지 않으면 실행하지 마세요)
--   3) 사용자의 명시적 실행 승인
-- 을 모두 만족해야 합니다.
--
-- ------------------------------------------------------------
-- 문제
-- ------------------------------------------------------------
-- 기존 "개인권한 조회" SELECT 정책(add_personal_permissions.sql, reservation_functions.sql에
-- 동일하게 정의됨)은 다음 조건만 확인했습니다.
--
--   manager_center_id in (
--       select id from manager_centers
--       where center_id in (select my_managed_center_ids())
--   )
--
-- 즉 "같은 센터에 소속된 활성 스태프이기만 하면" 그 센터의 모든 스태프의 개인 권한
-- 예외(account_center_permissions.grant_type = allow/deny)를 전부 읽을 수 있었습니다.
-- 테이블 코멘트와 정책 주석 모두 "오너만 조회/설정 가능 (facility.role_permission 권한)"이라고
-- 명시하고 있었지만, 실제 SELECT 정책 구현에는 그 권한 체크가 빠져 있었습니다
-- (INSERT/UPDATE/DELETE 정책에는 has_permission(center_id, 'facility.role_permission')이
-- 정확히 들어가 있어 쓰기는 원래부터 안전했습니다 — 이번 수정은 SELECT 전용입니다).
--
-- 이 gap은 app/manager/staff/permissions/page.tsx의 클라이언트 가드(ACL-003, isOwnerOfCenter())와
-- 무관하게 존재했습니다 — 화면 가드를 완전히 우회해 Supabase SDK/REST로 직접
-- `select * from account_center_permissions where manager_center_id = '<다른 스태프의 mc id>'`를
-- 호출해도 그대로 성공하는 구조였습니다.
--
-- ------------------------------------------------------------
-- 수정 방향
-- ------------------------------------------------------------
-- "본인 것" 또는 "facility.role_permission 권한 보유자(오너 포함)"만 조회 가능하도록 좁힙니다.
--
-- "본인 것" 허용이 반드시 필요한 이유: lib/roles.ts의 fetchMyEffectivePermissionKeys()
-- (ACL-004, 매니저 홈 메뉴 노출 계산에 사용)가 로그인한 스태프 "본인"의 manager_center_id로
-- fetchStaffOverrides()를 호출합니다. 이 경로까지 막으면 오너가 아닌 일반 스태프는 자기 자신의
-- 메뉴 노출조차 계산할 수 없게 되는 회귀가 발생합니다. 따라서 단순히
-- "has_permission(center_id,'facility.role_permission')만 허용"으로 좁히면 안 됩니다.
-- ============================================================

drop policy if exists "개인권한 조회" on account_center_permissions;
create policy "개인권한 조회"
    on account_center_permissions for select
    using (
        -- 1) 본인 것 (ACL-004의 fetchMyEffectivePermissionKeys()가 의존)
        manager_center_id in (
            select id from manager_centers where account_id = my_account_id()
        )
        -- 2) facility.role_permission 권한 보유자(오너 포함) — 다른 스태프 것 조회
        or manager_center_id in (
            select mc.id from manager_centers mc
            where has_permission(mc.center_id, 'facility.role_permission')
        )
    );

-- INSERT/UPDATE/DELETE 정책은 변경하지 않습니다(기존에도 has_permission() 체크가 이미 있어 안전).
