-- ============================================================
-- HOTFIX(P0, Live 재현 확인됨): center_roles "내 센터 역할 조회" RLS 무한 재귀
--   → 스태프 초대 기능이 "infinite recursion detected in policy for
--     relation manager_centers" 에러로 완전히 깨져 있는 문제
--
-- [사용자가 직접 재현 확인함, 2026-08-13]
--   /manager/staff 화면에서 스태프 초대 시도 → "스태프 추가에 실패했어요:
--   infinite recursion detected in policy for relation manager_centers"
--
-- [근본 원인]
--   center_roles의 "내 센터 역할 조회" SELECT 정책(reservation_functions.sql:574-576)이
--   manager_centers를 security definer 헬퍼 없이 직접(raw) 서브쿼리한다:
--
--     using (center_id in (select center_id from manager_centers where account_id = my_account_id()))
--
--   fix_manager_centers_privilege_escalation_draft_proposed.sql(SEC-101/112/113, Live
--   적용됨)이 "오너 스태프 초대"/"오너 스태프 수정" 정책에 추가한 cross-center role_id
--   주입 방어(SEC-112(b))가 다음 조건으로 center_roles를 조회한다:
--
--     role_id in (select id from center_roles cr where cr.center_id = manager_centers.center_id)
--
--   결과: manager_centers INSERT/UPDATE(스태프 초대/역할 변경) → 정책 평가 중
--   center_roles 조회 → center_roles "내 센터 역할 조회" 정책 평가 중 manager_centers를
--   다시 raw 조회 → PostgreSQL이 순환을 감지해 즉시 차단한다. 이 순환의 근본 원인은
--   center_roles 쪽 정책이지, SEC-112의 cross-center 방어(그 자체는 정확함, 이번 파일이
--   건드리지 않음) 쪽이 아니다 — "오너 스태프 조회"(manager_centers SELECT) 정책은 이미
--   my_managed_center_ids()(security definer, RLS를 다시 타지 않음)를 쓰고 있어 동일한
--   패턴의 문제가 없다. center_roles의 이 정책만 그 패턴을 따르지 않았다.
--
-- [고친 것] "내 센터 역할 조회"를 my_managed_center_ids() 기반으로 교체 — 이미 검증된
--   기존 패턴(위 "오너 스태프 조회"와 동일)을 그대로 재사용, 새로 발명하지 않음.
--
-- [의미 차이] 기존 정책은 status 무관(pending 포함)하게 조회를 허용했으나,
--   my_managed_center_ids()는 status='active'만 포함한다. lib/centers.ts(부트스트랩)/
--   lib/roles.ts(초대) 모두 항상 즉시 status='active'로 insert하므로 실사용 영향 없음
--   (pending 상태 자체가 이 스키마에 존재하지 않는 흐름) — 오히려 다른 모든 곳(오너
--   스태프 조회 등)과 판정 기준이 일관되게 맞춰진다.
--
-- [범위] 이 파일은 fix_manager_centers_privilege_model_draft_proposed.sql([7]번 섹션과
--   동일한 수정)에서 이 재귀 버그 수정 "만" 분리해 독립 파일로 만들었다 — 그 파일의
--   나머지 변경(has_permission() defense-in-depth, role_id/center_id 정합성 trigger)은
--   포함하지 않는다. 그건 SEC-101/112/113 P0 batch와 무관한 별도 hardening 범위이고,
--   지금 필요한 건 "지금 당장 깨진 스태프 초대 기능 복구"뿐이기 때문이다.
--
-- [영향받는 기존 데이터] 없음(정책 재정의만, 테이블/데이터 변경 없음).
-- [위험도] 낮음 — 정책 하나의 USING 절만 이미 검증된 동등 패턴으로 교체.
--
-- 여러 번 실행해도 안전(drop policy if exists + create policy).
-- ============================================================

BEGIN;

drop policy if exists "내 센터 역할 조회" on center_roles;
create policy "내 센터 역할 조회"
    on center_roles for select
    using (center_id in (select my_managed_center_ids()));

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select policyname, qual from pg_policies where tablename = 'center_roles' and policyname = '내 센터 역할 조회';
-- 적용 후 /manager/staff에서 스태프 초대가 정상 동작하는지 실제로 재현 확인 권장
-- (또는 tests/integration/manager-centers-privilege-escalation.test.ts의 "E~F: 정상
-- 스태프 초대" 케이스가 이제 통과하는지 CI에서 확인).
