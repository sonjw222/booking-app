-- ============================================================
-- HOTFIX v3(P0, Live 재현 확인됨): manager_centers 자체 정책에 남아있던 raw
--   self-subquery 제거 — v1(center_roles)/v2(has_permission) 적용 후에도 재현됨
--
-- [근본 원인 3 — 가장 직접적인 원인]
--   "매니저센터 생성"(INSERT)과 "오너 스태프 삭제"(DELETE) 정책이 manager_centers
--   자기 자신을 함수 없이 raw 서브쿼리로 되짚는다:
--     not exists (select 1 from manager_centers mc2 where mc2.center_id = manager_centers.center_id)
--     exists (select 1 from manager_centers mc2 where mc2.center_id = ... and mc2.id <> ...)
--   PostgreSQL RLS는 같은 command에 대해 permissive 정책 전부를 OR로 평가한다 —
--   즉 실제로는 "오너 스태프 초대" 경로로 들어온 INSERT(스태프 초대)라도 "매니저센터
--   생성" 정책의 WITH CHECK도 함께 평가된다. 이 raw self-subquery는 v1/v2와 달리
--   어떤 함수로도 감싸여 있지 않아 rewriter가 manager_centers relation을 자기
--   자신의 정책 평가 도중 다시 참조하는 것으로 직접 인식한다 — my_managed_center_ids()/
--   has_permission()처럼 security definer 함수 호출(rewriter에게 opaque)로 우회되지
--   않는, 가장 직접적인 형태의 자기참조.
--
--   "오너 스태프 초대"/"오너 스태프 수정"의 role_id 검사(center_roles 서브쿼리)도
--   v1/v2 이후 이론상 안전해졌어야 하나, 반복된 재현 실패를 감안해 이번에 함께
--   함수로 감싸 방어선을 통일한다(라운드트립 비용을 줄이기 위한 선제 조치).
--
-- [고친 것] manager_centers/center_roles 자기·상호 참조를 전부 security definer
--   helper 함수 호출로 치환 — 로직/의미는 전혀 바꾸지 않는다(동일 조건을 함수로
--   감쌌을 뿐).
--
--     manager_centers_has_any_row(center_id, exclude_id default null)
--       := exists(그 center_id의 manager_centers 행, exclude_id 있으면 그 행만 제외)
--     role_id_belongs_to_center(role_id, center_id)
--       := 그 role_id가 그 center_id의 center_roles에 속하는가
--     role_id_is_owner_for_center(role_id, center_id)
--       := 그 role_id가 그 center_id의 center_roles 중 is_owner=true인가
--
-- [영향받는 기존 데이터] 없음(정책/함수 재정의만).
-- [위험도] 낮음 — 조건식 자체는 원본과 100% 동일, 표현 방식만 함수 호출로 변경.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] helper 함수 3종
-- ------------------------------------------------------------
create or replace function manager_centers_has_any_row(p_center_id uuid, p_exclude_id uuid default null)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists(
        select 1 from manager_centers
        where center_id = p_center_id
          and (p_exclude_id is null or id <> p_exclude_id)
    );
$$;

create or replace function role_id_belongs_to_center(p_role_id uuid, p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists(
        select 1 from center_roles where id = p_role_id and center_id = p_center_id
    );
$$;

create or replace function role_id_is_owner_for_center(p_role_id uuid, p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists(
        select 1 from center_roles where id = p_role_id and center_id = p_center_id and is_owner = true
    );
$$;

-- ------------------------------------------------------------
-- [2] INSERT "매니저센터 생성" — raw self-subquery만 helper로 치환, 조건 동일
-- ------------------------------------------------------------
drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (
        account_id = my_account_id()
        and role_id is null
        and not manager_centers_has_any_row(center_id)
    );

-- ------------------------------------------------------------
-- [3] INSERT "오너 스태프 초대" — role_id 검사만 helper로 치환, 조건 동일
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (
        has_permission(center_id, 'facility.staff.create')
        and (
            role_id is null
            or role_id_belongs_to_center(role_id, center_id)
        )
    );

-- ------------------------------------------------------------
-- [4] UPDATE "오너 스태프 수정" — role_id 검사만 helper로 치환, 조건 동일
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (
        (account_id = my_account_id() and role_id is null)
        or has_permission(center_id, 'facility.staff.update')
    )
    with check (
        (
            role_id is null
            or role_id_belongs_to_center(role_id, center_id)
        )
        and (
            (
                account_id = my_account_id()
                and status = 'active'
                and role_id_is_owner_for_center(role_id, center_id)
            )
            or has_permission(center_id, 'facility.staff.update')
        )
    );

-- ------------------------------------------------------------
-- [5] DELETE "오너 스태프 삭제" — raw self-subquery만 helper로 치환, 조건 동일
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (
        (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'))
        and manager_centers_has_any_row(center_id, id)
    );

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select tablename, policyname, cmd, qual, with_check
from pg_policies where tablename = 'manager_centers' order by cmd, policyname;
-- 적용 후 /manager/staff에서 스태프 초대 다시 시도.
