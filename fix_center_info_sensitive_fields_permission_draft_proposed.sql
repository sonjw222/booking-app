-- ============================================================
-- P1-13 — 센터정보(`/manager/center-info`) 민감 필드에 권한 검사 추가
--
-- [배경] app/manager/center-info/page.tsx 상단 주석은 "시설 정보 설정 권한(facility.info)
-- 필요 — 오너는 항상 가능"이라고 적혀 있지만, 실제 RLS 정책("매니저 센터 수정",
-- reservation_functions.sql)은 `id in (select my_managed_center_ids())`만 확인한다 —
-- 그 센터의 active 스태프면 role/권한과 무관하게 누구나 이 페이지의 모든 필드(소개글/주소/
-- 전화/사진/SNS/카테고리/좌표/결제수단/후기 포인트)를 수정할 수 있었다.
--
-- 이 중 두 필드는 실제 금전/포인트 이코노미에 직결돼 진짜 위험하다:
--   - pay_methods(결제수단): 센터가 어떤 결제수단을 받을지 지정. add_new_permissions.sql이
--     이미 이걸 위한 permission key 'facility.paymethod'를 만들어뒀고 오너 역할에만
--     기본 부여했지만(다른 역할엔 기본 부여 안 함 — "오너가 원하면 위임" 설계), 그 권한을
--     실제로 검사하는 RLS/트리거가 어디에도 없어서 지금은 이 위임 설계 자체가 죽어있다.
--   - review_point(후기 1건당 지급 포인트, add_reviews_points.sql): 대응하는 permission
--     key가 아예 없다 — 포인트 이코노미에 직결되므로 일단 오너 전용으로 막는다.
--
-- 나머지 필드(소개글/주소/전화/사진/SNS/카테고리/좌표)는 실질적 위험이 낮고, "센터 소속
-- active 스태프면 누구나 매장 정보를 최신화할 수 있는" 현재 동작이 오히려 실용적일 수
-- 있다는 사용자 확인을 받아 그대로 둔다 — 이 파일은 그 필드들의 RLS를 전혀 바꾸지 않는다.
--
-- [설계] centers 테이블 UPDATE 정책은 테이블(행) 단위라 컬럼별로 다른 권한을 걸 수 없다.
-- 이미 이 테이블에 있는 guard_center_status_change() 트리거(status 필드만 별도로
-- platform admin 전용으로 막는 패턴)와 동일한 방식으로, BEFORE UPDATE 트리거 하나를 추가해
-- pay_methods/review_point가 실제로 바뀌는 요청만 추가 검사한다. 그 외 필드 변경은 기존
-- "매니저 센터 수정" RLS(활성 스태프면 통과) 그대로 적용된다.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

-- [1] "이 계정이 이 센터의 오너인가" 직접 확인하는 헬퍼(has_permission()과 달리 특정
-- permission key와 무관하게 오너 여부 자체만 본다 — review_point처럼 대응 키가 없는
-- 필드에 씀).
create or replace function is_center_owner(p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from manager_centers mc
        join center_roles r on r.id = mc.role_id
        where mc.account_id = my_account_id()
          and mc.center_id = p_center_id
          and mc.status = 'active'
          and r.is_owner = true
    );
$$;

-- [2] 민감 필드 변경 가드
create or replace function guard_center_sensitive_fields_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.pay_methods is distinct from old.pay_methods then
        if not (is_platform_admin() or has_permission(new.id, 'facility.paymethod')) then
            raise exception '결제수단을 변경할 권한이 없어요';
        end if;
    end if;

    if new.review_point is distinct from old.review_point then
        if not (is_platform_admin() or is_center_owner(new.id)) then
            raise exception '후기 적립 포인트를 변경할 권한이 없어요(오너만 가능)';
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists guard_center_sensitive_fields_change_trigger on centers;
create trigger guard_center_sensitive_fields_change_trigger
    before update on centers
    for each row
    execute function guard_center_sensitive_fields_change();

COMMIT;

-- ============================================================
-- 완료 후 아래로 확인:
--   1) 오너 계정으로 pay_methods/review_point 변경 → 정상 성공
--   2) facility.paymethod 권한 없는 일반 스태프 계정으로 pay_methods만 변경 시도 → 거부
--      ("결제수단을 변경할 권한이 없어요")
--   3) 같은 스태프 계정으로 intro/address/phone 등 다른 필드만 변경 → 정상 성공(기존 동작 유지)
--   4) 같은 스태프 계정으로 review_point 변경 시도 → 거부("...오너만 가능")
--   5) 오너가 "역할별 권한 설정" 화면에서 특정 스태프에게 facility.paymethod를 명시적으로
--      부여한 뒤, 그 스태프 계정으로 pay_methods 변경 → 정상 성공(위임 동작 확인)
-- ============================================================
