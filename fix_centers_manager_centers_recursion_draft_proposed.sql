-- ============================================================
-- HOTFIX v4(P0, Live 재현 확인됨): centers 정책의 기존 raw subquery가
--   manager_centers와 새로 얽히며 발생한 4번째 재귀 경로
--
-- [배경] v1(center_roles)/v2(has_permission)/v3(manager_centers 자체 정책) 적용 후에도
--   재귀가 재현됐고, 이후 "매니저센터 생성" INSERT 정책에
--   `EXISTS(select 1 from centers c where c.id = manager_centers.center_id and
--   c.status = 'pending')`(orphan/이미 approved된 센터 self-claim 잔여 경로 차단용,
--   SEC-101 후속 조치)가 추가되면서 처음으로 다음 경로가 드러남:
--
--     manager_centers INSERT 정책 → centers를 raw 참조(위 EXISTS)
--       → centers "승인된 센터 조회" SELECT 정책 평가
--       → 그 정책의 세 번째 절이 manager_centers를 다시 raw 참조:
--            id in (select center_id from manager_centers where account_id = my_account_id())
--       → 순환
--
--   이 `centers`의 "승인된 센터 조회" 정책(reservation_functions.sql:444-451,
--   add_platform_admin.sql에도 동일 재선언)은 이번 P0 배치 어느 세션도 새로 건드리지
--   않은 기존 정책이다 — v1~v3가 지금까지 이 경로를 건드리지 않아 드러나지 않았을 뿐,
--   근본적으로는 v1~v3와 동일한 종류의(raw subquery) 잠재 결함이었다.
--
-- [고친 것] my_managed_center_ids()는 status='active'만 걸러서 이 정책에 그대로 쓸 수
--   없다(주석에 명시돼 있듯 "가입 직후 승인대기 상태인 내 센터도 보이게" 하려고 status
--   무관하게 걸었던 것) — 그래서 동일 패턴으로 status 필터 없는 신규 헬퍼
--   my_center_ids_any_status()를 추가하고, 그 절만 이걸로 치환한다. 조건 자체(내가
--   속한 센터면 무조건 보임)는 전혀 바뀌지 않는다.
--
-- [영향받는 기존 데이터] 없음(함수/정책 재정의만).
-- [위험도] 낮음 — 기존 v1~v3와 동일한, 이미 검증된 패턴 재사용.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace function my_center_ids_any_status()
returns setof uuid
language sql stable
security definer
set search_path = public
as $$
    select center_id from manager_centers where account_id = my_account_id();
$$;

drop policy if exists "승인된 센터 조회" on centers;
create policy "승인된 센터 조회"
    on centers for select using (
        status = 'approved'
        or id in (select my_managed_center_ids())
        -- 가입 직후 승인대기 상태인 내 센터도 보이게 (status 필터 없음, 기존과 동일)
        or id in (select my_center_ids_any_status())
        or is_platform_admin()
    );

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select policyname, qual from pg_policies where tablename = 'centers' and policyname = '승인된 센터 조회';
-- 적용 후 /manager/staff에서 스태프 초대 다시 시도.
