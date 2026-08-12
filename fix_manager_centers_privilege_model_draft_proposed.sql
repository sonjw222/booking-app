-- ============================================================
-- manager_centers 권한 모델 완결(SEC-101 + SEC-112 + SEC-113 + has_permission defense-in-depth
--                                + RLS 무한 재귀 3겹 hotfix 통합)
--
-- 이 파일은 fix_manager_centers_privilege_escalation_draft_proposed.sql(이미 Live 적용됨,
-- SEC-101/112/113 RLS 정책 3종)을 **대체**한다.
--
-- ⚠⚠⚠ 2026-08-13 재조정(reconciliation) 안내 ⚠⚠⚠
-- 이 파일은 원래 has_permission() defense-in-depth + role_id/center_id trigger 2가지만
-- 새로 추가할 계획이었으나, CI/실사용 재현 과정에서 **3겹으로 겹친 RLS 무한 재귀 버그**가
-- 드러나 다른 세션이 별도의 독립 hotfix 3개 파일로 순서대로 진단·수정했고, **사용자가
-- 이미 Live에 그 3개를 전부 적용해 스태프 초대 정상 동작을 실측 확인했다**(2026-08-13):
--   1. fix_center_roles_manager_centers_recursion_draft_proposed.sql (Live 적용됨)
--   2. fix_has_permission_manager_centers_recursion_draft_proposed.sql (Live 적용됨)
--   3. fix_manager_centers_self_reference_recursion_draft_proposed.sql (Live 적용됨)
-- 이 파일은 그 3개 hotfix가 만든 **현재 Live 상태와 일치하도록** [1]~[4], [6], [7]을
-- 다시 맞췄다 — 그래야 이 파일을 나중에 (재)적용해도 이미 Live에 있는 수정을 실수로
-- 되돌리지 않는다(전부 DROP POLICY/CREATE OR REPLACE라 멱등하지만, "멱등"은 "내용이
-- 최신"이라는 뜻이 아니므로 반드시 이 재조정이 필요했다). **이 파일에서 hotfix 3개 대비
-- 유일하게 남는 진짜 신규 변경은 [5]번 trigger와 [6]번 has_permission()의 `r.center_id =
-- mc.center_id` cross-center join 조건 추가뿐**이다 — 나머지는 전부 hotfix 3개와 동일한
-- 내용의 재선언(멱등, 안전).
--
-- ============================================================
-- [🚨 RLS 무한 재귀 3겹 — 근본 원인 전체 요약]
-- ============================================================
--   fix_manager_centers_privilege_escalation_draft_proposed.sql(2026-08-12 Live 적용)이
--   도입한 cross-center role_id 검사(SEC-112(b))가 `manager_centers`/`center_roles`
--   상호 참조와 결합해 "infinite recursion detected in policy for relation
--   manager_centers"로 스태프 초대(/manager/staff)가 완전히 깨졌다. 원인은 raw
--   (non-security-definer) 서브쿼리 3곳이 겹쳐 있었다(사용자가 실제로 하나씩 적용하며
--   재현 확인, 2026-08-13):
--
--   1) `center_roles`의 "내 센터 역할 조회" SELECT 정책이 `manager_centers`를 raw
--      서브쿼리로 되짚음 → [7]에서 my_managed_center_ids()로 교체.
--   2) `has_permission()` 자체가 security definer가 아니어서 `manager_centers`/
--      `center_roles`를 caller 권한(raw)으로 JOIN함 → [6]에서 security definer로 전환.
--   3) (가장 직접적인 원인) `manager_centers`의 "매니저센터 생성"/"오너 스태프 삭제"
--      정책 자체가 `manager_centers`를 함수 없이 raw self-subquery로 되짚음 — 같은
--      command에 대해 permissive 정책은 전부 OR로 평가되므로, "오너 스태프 초대"
--      경로로 들어온 INSERT라도 "매니저센터 생성"의 WITH CHECK가 함께 평가되며 걸림
--      → [1]~[4]에서 신규 helper 함수(전부 security definer)로 치환.
--
--   3개 전부 고쳐야만 순환이 완전히 끊긴다(1개나 2개만 고치면 남은 겹에서 계속 재현됨
--   — 실제로 사용자가 순서대로 적용하며 이를 실측했다).
--
-- ============================================================
-- [보안 invariant — 이 파일이 보장해야 하는 것]
-- ============================================================
--   A. 기존 center의 최초 manager 관계를 일반 사용자가 임의로 만들 수 없다.
--   B. 정상 신규 center 생성자만 최초 owner bootstrap 가능하다.
--   C. 새 staff 추가는 facility.staff.create 권한을 가진 caller만 가능하다.
--   D. staff role 변경은 facility.staff.update 권한을 가진 caller만 가능하다.
--   E. 일반 staff는 자신의 role/status를 권한 상승 방향으로 변경할 수 없다.
--   F. manager_centers.role_id는 반드시 manager_centers.center_id와 동일한
--      center_roles.center_id 소속이어야 한다(RLS + trigger 이중 방어).
--   G. 마지막 owner/관리 관계를 삭제해 center를 orphan 상태로 만드는 행위는 DB 레벨에서
--      차단된다.
--   H. 한 account가 여러 center에서 서로 다른 role(회원/오너/스태프/매니저)을 갖는 것은
--      정상이며 이 파일의 어떤 정책도 이를 제한하지 않는다.
--   I. 위 A~H를 만족시키는 모든 정책 평가는 RLS 무한 재귀를 일으키지 않는다(신규
--      invariant, 이번 재조정으로 추가) — manager_centers/center_roles를 서로 또는
--      스스로 되짚는 모든 조건은 security definer 함수로 감싼다.
--
-- ============================================================
-- [PART 1 — SEC-113 확정 조사 결과]
-- ============================================================
--   1) "오너 스태프 삭제" 정책의 원본(add_staff_permissions.sql) 정의:
--        using (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'))
--      → self 분기에 "마지막 행인가" 제약이 전혀 없었다(CONFIRMED, 코드 확인).
--   2) self-delete 분기는 오너/일반 staff 구분 없이 "자기 행"이면 전부 허용 — is_owner
--      여부를 별도로 확인하지 않는다. 즉 오너든 저권한 스태프든 자기 자신을 지우는 것
--      자체는 원래 정상 기능(스태프 탈퇴)이라 이 자체를 막으면 안 된다 — "마지막 남은
--      한 명인가"만 막아야 한다(요구사항 G).
--   3) "센터당 owner 최소 1명" 같은 명시적 규칙은 스키마/코드 어디에도 없었다 — 이번
--      트리거로 사실상 "최소 1명(누구든)" 규칙로 대체함. "owner가 반드시 있어야 한다"는
--      더 강한 규칙은 이번 배치 범위 밖(PART 3 "장기 권장" 참고).
--   4) UI가 막아도 REST/PostgREST로 직접 DELETE하면 RLS만이 유일한 방어선이다.
--   5) centers 행은 남아있는데 manager_centers가 0건인 상태(= orphan)는 스키마상
--      아무 제약 없이 가능했다(FK 등으로 자동 방지되지 않음, CONFIRMED).
--   6) Live에 이미 orphan center가 존재하는지는 diagnose_manager_centers_orphan_and_
--      mismatch_readonly.sql을 사용자가 직접 실행해 확인할 것.
--
-- ============================================================
-- [PART 3 — 설계안 비교(A/B/C/D), 최종 A안 채택]
-- ============================================================
--   A) [채택, 최소 수정] 기존 RLS patch + last-owner DELETE guard — SQL만으로 완결,
--      코드 변경 없음, 이미 Live 적용 완료(recursion hotfix 3종 포함).
--   B) center.created_by_account_id 같은 명시적 provenance 필드 — 스키마 변경 필요,
--      이번 SQL-only 범위를 넘어섬(후보 제외).
--   C) 센터 생성 + owner bootstrap을 SECURITY DEFINER atomic RPC로 통합 — 가장 근본적,
--      코드 변경 필수, 장기 권장 아키텍처로 남김.
--   D) trigger 기반 owner bootstrap — SECURITY DEFINER 트리거 필요, C안보다 암묵적.
--
--   → **지금 최소 수정(즉시 출시)**: A(이미 적용됨) + has_permission defense-in-depth
--     + role_id/center_id trigger + recursion hotfix 3종(이미 Live 적용됨).
--   → **장기 권장**: C(atomic RPC), 별도 코드 변경 배치로 분리 권장.
--
-- ============================================================
-- [PART 4 — role_id/center_id invariant 강제 방법 비교]
-- ============================================================
--   RLS만으로는 불충분하다(service_role/미래 SECURITY DEFINER RPC가 우회 가능).
--   CHECK 제약은 다른 테이블 참조 서브쿼리를 지원하지 않아 후보에서 제외.
--   → **BEFORE INSERT OR UPDATE 트리거 채택**: RLS와 독립적으로 테이블 레벨에서
--   role_id/center_id 정합성을 강제한다([5]).
--
-- ============================================================
-- [PART 5 — has_permission() cross-center 검증 감사 결과]
-- ============================================================
--   `join center_roles r on r.id = mc.role_id`가 `r.center_id = mc.center_id`를
--   확인하지 않아, mc.role_id가 어떤 경로로든 다른 센터의 owner role을 가리키면
--   r.is_owner가 그대로 true로 읽히는 단일 실패점이었다(CONFIRMED). RLS/trigger로
--   보장되는 정상 데이터에는 이 조건이 항상 참이므로 정상 기능에 영향 없이 defense-
--   in-depth로 추가한다([6]). hotfix v2(Live 적용됨)는 security definer 전환만
--   했고 이 조건은 포함하지 않았으므로, 이 파일이 그 gap을 마저 닫는다.
--
-- [영향받는 기존 데이터] 없음(함수/트리거/정책 재정의만, 테이블 데이터 변경 없음).
-- [위험도] 매우 낮음 — hotfix 3종과 동일 내용 재선언(멱등) + 순수 defense-in-depth 추가.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [0] 신규(hotfix v3와 동일) — manager_centers/center_roles 자기·상호 참조를
--     전부 security definer helper 함수로 치환하기 위한 helper 3종.
--     조건식 자체는 원본과 100% 동일 — 표현 방식만 함수 호출로 변경(rewriter에게
--     opaque해져 재귀 경로를 원천 차단).
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
-- [1] INSERT "매니저센터 생성" — SEC-101 (hotfix v3와 동일 재선언 — helper 함수 사용)
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
-- [2] INSERT "오너 스태프 초대" — SEC-112(a) (hotfix v3와 동일 재선언 — helper 함수 사용)
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
-- [3] UPDATE "오너 스태프 수정" — SEC-112(b) (hotfix v3와 동일 재선언 — helper 함수 사용)
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
-- [4] DELETE "오너 스태프 삭제" — SEC-113 (hotfix v3와 동일 재선언 — helper 함수 사용)
-- ------------------------------------------------------------
drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (
        (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'))
        and manager_centers_has_any_row(center_id, id)
    );

-- ------------------------------------------------------------
-- [5] 신규 — role_id/center_id 정합성 trigger (PART 4). hotfix 3종에는 없던,
--     이 파일에서만 새로 추가하는 진짜 신규 변경 중 하나.
--     RLS와 독립적인 테이블 레벨 방어선. service_role/미래 RPC의 직접 쓰기까지 방어.
-- ------------------------------------------------------------
create or replace function manager_centers_enforce_role_center_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.role_id is not null and not exists (
        select 1 from center_roles cr
        where cr.id = new.role_id and cr.center_id = new.center_id
    ) then
        raise exception 'manager_centers.role_id는 반드시 같은 center_id의 center_roles여야 해요 (center_id=%, role_id=%)',
            new.center_id, new.role_id;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_manager_centers_role_center_match on manager_centers;
create trigger trg_manager_centers_role_center_match
    before insert or update on manager_centers
    for each row
    execute function manager_centers_enforce_role_center_match();

-- ------------------------------------------------------------
-- [6] has_permission() — hotfix v2(security definer 전환, Live 적용됨)와 이 파일의
--     원래 계획(PART 5, cross-center join 조건 추가)을 합친 최종본. hotfix v2 단독
--     적용 상태에는 join 조건이 없었으므로, 이 섹션이 그 gap을 마저 닫는 진짜 신규
--     변경이다. 함수 시그니처/반환값/정상 케이스 동작은 전부 동일 — security definer +
--     join 조건 하나만 추가.
-- ------------------------------------------------------------
create or replace function has_permission(p_center_id uuid, p_permission text)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    with me as (
        select mc.id as mc_id, r.is_owner, mc.role_id
        from manager_centers mc
        join center_roles r on r.id = mc.role_id and r.center_id = mc.center_id
        where mc.account_id = my_account_id()
          and mc.center_id = p_center_id
          and mc.status = 'active'
        limit 1
    )
    select coalesce((
        select
            case
                when m.is_owner then true
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'deny'
                ) then false
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'allow'
                ) then true
                when exists (
                    select 1 from role_permissions rp
                    where rp.role_id = m.role_id
                      and rp.permission_key = p_permission
                ) then true
                else false
            end
        from me m
    ), false);
$$;

-- ------------------------------------------------------------
-- [7] center_roles "내 센터 역할 조회" — hotfix v1과 동일 재선언(Live 적용됨, 멱등).
-- ------------------------------------------------------------
drop policy if exists "내 센터 역할 조회" on center_roles;
create policy "내 센터 역할 조회"
    on center_roles for select
    using (center_id in (select my_managed_center_ids()));

COMMIT;

-- ============================================================
-- 완료.
--   - [0]~[4], [7]: hotfix 3종(2026-08-13 Live 적용·사용자 확인됨)과 동일한 내용의
--     재선언 — 이 파일을 (재)적용해도 이미 검증된 Live 상태를 되돌리지 않음.
--   - [5] 신규 trigger: role_id/center_id mismatch를 어떤 쓰기 경로로도(RLS 우회 포함)
--     차단. 아직 Live 미적용.
--   - [6] has_permission(): hotfix v2의 security definer 전환에 cross-center join
--     조건까지 추가한 최종본. 아직 Live 미적용(hotfix v2까지만 적용된 상태이므로
--     join 조건 부분만 신규).
-- ============================================================
