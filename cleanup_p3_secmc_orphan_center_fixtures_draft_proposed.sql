-- ============================================================
-- P3 타센터 격리테스트 / SEC-MC-* manager_centers 테스트 fixture 누적 정리 (draft, 미실행)
--
-- [배경 — 코드 감사로 확인, 추측 아님]
-- 아래 3개 테스트 파일이 "타 센터" 역할의 centers 행을 매 실행 무조건 새로 INSERT
-- 하면서(get-or-create가 아님), 정리는 afterAll에만 있었다:
--
--   1) tests/e2e/admin/class-allowed-products.spec.ts
--      → centers.name = 'P3 타센터-격리테스트' (+ products.name = 'P3 타센터전용패스')
--   2) tests/integration/class-allowed-products-enforcement.test.ts
--      → centers.name = 'P3 통합-타센터' (+ products.name = 'P3 통합-타센터패스')
--   3) tests/integration/manager-centers-privilege-escalation.test.ts (SEC-101/112 회귀
--      테스트, 이 저장소에서 "SEC-MC-*" 계열로 부르는 파일)
--      → centers.name in ('SEC-D/K 부트스트랩 테스트센터', 'SEC-J 타센터 role 탈취용',
--                          'SEC-Q orphan(approved) 재현용', 'SEC-Q-2 pending 대조군')
--
-- 셋 다 GitHub Actions cancel-in-progress 등으로 afterAll 전에 실행이 죽으면 그 행이
-- 영구히 남고, beforeAll/afterAll 어느 쪽도 "이미 이 이름으로 leaked된 게 있는지"를
-- 확인하지 않아 다음 실행이 또 새로 만든다 — 이 저장소에 이미 여러 번 기록된
-- "공유 테스트센터 오염"/"P1-14 waitlisted 누적"과 동일한 근본 패턴(원인: get-or-create
-- 부재 + afterAll-only cleanup).
--
-- [코드 수정 — 이 SQL과 별도로 이미 반영, 이 파일 범위 밖]
-- 3개 파일 전부 이번 배치에서 self-healing으로 전환했다:
--   - 1)/2): centers.name/products.name 기준 get-or-create로 전환, afterAll의 삭제
--     제거(getOrCreateOwnedTestCenter()와 동일 철학 — 영구 재사용 공유 fixture).
--   - 3): beforeAll 맨 앞에서 4개 고정 이름의 기존 잔재를 전부 쓸어내는
--     sweepStaleFixtureCenters() 추가(이 파일의 센터들은 부트스트랩/orphan "생성" 자체를
--     검증하는 게 목적이라 재사용이 아니라 "항상 깨끗하게 시작"이 맞는 전략).
--
-- ⚠ [중요, 이 SQL이 필요한 이유] get-or-create로 바꾼 1)/2)는 이미 같은 이름의 행이
-- 2개 이상 쌓여 있으면 .maybeSingle()이 "복수 행" 에러를 던지며 그대로 깨진다 — 즉
-- 이 정리 SQL은 "하면 좋은 것"이 아니라 코드 수정이 실제로 동작하기 위한 선행조건이다.
-- 3)의 sweep은 자기 스스로 정리하므로 이 SQL 없이도 다음 실행부터는 안전하지만, 지금
-- 당장 쌓여 있는 과거분은 이 SQL로 한 번 정리해야 한다.
--
-- [정확한 대상 판정 기준]
-- centers.name이 위 6개 리터럴과 정확히(=, LIKE 아님) 일치하는 행만 대상. 실제 사용자가
-- 만든 센터가 우연히 이 문자열과 완전히 같을 가능성은 사실상 0(각 이름 자체가 "테스트"/
-- "SEC-"/영문 코드명을 포함한, 실제 사업자명일 수 없는 내부 테스트 리터럴). 추가 안전장치로
-- status(P3 계열은 'approved', SEC-계열은 status 무관하게 이름만으로 매칭)와 address/
-- phone/business_number가 전부 NULL이거나 테스트 전용 값('테스트', '010-0000-0000',
-- '000-00-0000X')인지도 A-3에서 함께 확인한다 — 하나라도 실제 사업자 정보처럼 보이는
-- 값이 있으면 그 행은 자동으로 보존 대상에서 제외하고 사람이 직접 확인해야 한다.
--
-- [실행 순서 — 반드시 순서대로]
--   A(선택, read-only, 몇 번이든 안전) → B(atomic, 반드시 BEGIN~COMMIT 한 번에 Run) → C(검증)
-- ============================================================


-- ============================================================
-- A. READ-ONLY PREVIEW — DB를 전혀 수정하지 않음. B 실행 전 몇 번이든 따로 실행해도 안전.
-- ============================================================

-- A-1. 대상 이름별 centers 누적 건수(1건 초과면 leaked, 정상이면 P3 계열은 최대 1건,
-- SEC-계열은 0건이 정상 — 테스트 실행 중이 아닐 때 기준)
select name, count(*) as row_count, array_agg(id order by created_at) as ids, array_agg(status order by created_at) as statuses
from centers
where name in (
    'P3 타센터-격리테스트', 'P3 통합-타센터',
    'SEC-D/K 부트스트랩 테스트센터', 'SEC-J 타센터 role 탈취용',
    'SEC-Q orphan(approved) 재현용', 'SEC-Q-2 pending 대조군'
)
group by name
order by name;

-- A-2. 각 행의 상세(주소/전화/사업자번호가 테스트 전용 값인지 육안 확인용 — 실제 사업자
-- 정보가 하나라도 보이면 그 행 id는 B에서 제외해야 한다)
select id, name, status, address, phone, business_number, created_at
from centers
where name in (
    'P3 타센터-격리테스트', 'P3 통합-타센터',
    'SEC-D/K 부트스트랩 테스트센터', 'SEC-J 타센터 role 탈취용',
    'SEC-Q orphan(approved) 재현용', 'SEC-Q-2 pending 대조군'
)
order by name, created_at;

-- A-3. [2026-08-14 수정 — 이전 버전에 service_categories(center_id 자체가 없는
-- 전역 테이블)가 잘못 섞여 있어 42703 에러로 실패했다. python으로 저장소 전체
-- *.sql을 다시 스캔해 "center_id/target_center_id uuid ... references centers(id)"를
-- 실제로 갖는 테이블만 정확히 재추출했다(schema.sql뿐 아니라 add_announcements.sql/
-- add_reviews_points.sql처럼 나중 migration에서 컬럼이 추가된 테이블도 포함) —
-- products/manager_centers/center_roles(이미 B에서 직접 다룸) 제외 전부.
-- 이 6개 이름의 centers.id를 참조하는, "예상 밖" 테이블에 행이 있는지 전수 확인.
with target as (
    select id from centers where name in (
        'P3 타센터-격리테스트', 'P3 통합-타센터',
        'SEC-D/K 부트스트랩 테스트센터', 'SEC-J 타센터 role 탈취용',
        'SEC-Q orphan(approved) 재현용', 'SEC-Q-2 pending 대조군'
    )
)
select 'admin_action_logs' as table_name, count(*) from admin_action_logs where center_id in (select id from target)
union all select 'cart_items', count(*) from cart_items where center_id in (select id from target)
union all select 'center_announcements', count(*) from center_announcements where center_id in (select id from target)
union all select 'center_contacts', count(*) from center_contacts where center_id in (select id from target)
union all select 'center_holidays', count(*) from center_holidays where center_id in (select id from target)
union all select 'center_member_fields', count(*) from center_member_fields where center_id in (select id from target)
union all select 'center_members', count(*) from center_members where center_id in (select id from target)
union all select 'center_reviews', count(*) from center_reviews where center_id in (select id from target)
union all select 'center_settings', count(*) from center_settings where center_id in (select id from target)
union all select 'change_logs', count(*) from change_logs where center_id in (select id from target)
union all select 'class_types', count(*) from class_types where center_id in (select id from target)
union all select 'classes', count(*) from classes where center_id in (select id from target)
union all select 'community_posts', count(*) from community_posts where center_id in (select id from target)
union all select 'contract_templates', count(*) from contract_templates where center_id in (select id from target)
union all select 'contracts', count(*) from contracts where center_id in (select id from target)
union all select 'expenses', count(*) from expenses where center_id in (select id from target)
union all select 'inquiry_threads', count(*) from inquiry_threads where center_id in (select id from target)
union all select 'leads', count(*) from leads where center_id in (select id from target)
union all select 'lockers', count(*) from lockers where center_id in (select id from target)
union all select 'member_center_colors', count(*) from member_center_colors where center_id in (select id from target)
union all select 'member_grades', count(*) from member_grades where center_id in (select id from target)
union all select 'memberships', count(*) from memberships where center_id in (select id from target)
union all select 'messages', count(*) from messages where center_id in (select id from target)
union all select 'notification_logs', count(*) from notification_logs where center_id in (select id from target)
union all select 'notification_rules', count(*) from notification_rules where center_id in (select id from target)
union all select 'notifications', count(*) from notifications where center_id in (select id from target)
union all select 'orders', count(*) from orders where center_id in (select id from target)
union all select 'payments', count(*) from payments where center_id in (select id from target)
union all select 'point_accounts', count(*) from point_accounts where center_id in (select id from target)
union all select 'point_logs', count(*) from point_logs where center_id in (select id from target)
union all select 'point_transactions', count(*) from point_transactions where center_id in (select id from target)
union all select 'popup_notices', count(*) from popup_notices where center_id in (select id from target)
union all select 'profile_center_fields', count(*) from profile_center_fields where center_id in (select id from target)
union all select 'progress_categories', count(*) from progress_categories where center_id in (select id from target)
union all select 'purchase_requests', count(*) from purchase_requests where center_id in (select id from target)
union all select 'reviews(center_id)', count(*) from reviews where center_id in (select id from target)
union all select 'reviews(target_center_id)', count(*) from reviews where target_center_id in (select id from target)
union all select 'rooms', count(*) from rooms where center_id in (select id from target)
union all select 'schedule_templates', count(*) from schedule_templates where center_id in (select id from target)
union all select 'staff_salaries', count(*) from staff_salaries where center_id in (select id from target)
union all select 'staff_schedules', count(*) from staff_schedules where center_id in (select id from target)
union all select 'terms', count(*) from terms where center_id in (select id from target)
union all select 'products', count(*) from products where center_id in (select id from target)
union all select 'manager_centers', count(*) from manager_centers where center_id in (select id from target)
union all select 'center_roles', count(*) from center_roles where center_id in (select id from target)
order by 1;

-- A-4. P3 계열(get-or-create로 전환됨) — "가장 오래된 1건만 남기고 나머지 삭제" 대상
-- 미리보기(오래된 순으로 첫 번째만 KEEP, 나머지 REMOVE)
select name, id, created_at,
       row_number() over (partition by name order by created_at asc) as rn
from centers
where name in ('P3 타센터-격리테스트', 'P3 통합-타센터')
order by name, created_at;


-- ============================================================
-- B. ATOMIC CLEANUP — 아래 BEGIN부터 COMMIT까지 전체를 그대로 복사해서
--    Supabase SQL Editor에 붙여넣고 **한 번의 Run**으로 실행하세요.
-- ============================================================

BEGIN;

lock table manager_centers in share row exclusive mode;
lock table center_roles in share row exclusive mode;
lock table products in share row exclusive mode;
lock table centers in share row exclusive mode;

do $$
declare
    v_p3_keep_ids     uuid[];   -- P3 계열: 이름당 가장 오래된 1건, 삭제하지 않고 보존
    v_p3_remove_ids   uuid[];   -- P3 계열: 그 외 중복분(삭제 대상)
    v_secmc_ids       uuid[];   -- SEC-계열: 전부 삭제 대상(다음 테스트 실행이 다시 만듦)
    v_all_center_ids  uuid[];
    v_target_count    int;
    v_deleted_mc      int;
    v_deleted_roles   int;
    v_deleted_prod    int;
    v_deleted_centers int;
    v_remaining_after int;
begin
    -- 락 확보 후(=동시 쓰기 차단된 상태에서) 다시 계산한 진짜 현재값만 최종 판단 기준으로 쓴다.
    select array_agg(id) into v_p3_keep_ids
    from (
        select id, row_number() over (partition by name order by created_at asc) as rn
        from centers
        where name in ('P3 타센터-격리테스트', 'P3 통합-타센터')
    ) x
    where rn = 1;

    select array_agg(id) into v_p3_remove_ids
    from (
        select id, row_number() over (partition by name order by created_at asc) as rn
        from centers
        where name in ('P3 타센터-격리테스트', 'P3 통합-타센터')
    ) x
    where rn > 1;

    select array_agg(id) into v_secmc_ids
    from centers
    where name in (
        'SEC-D/K 부트스트랩 테스트센터', 'SEC-J 타센터 role 탈취용',
        'SEC-Q orphan(approved) 재현용', 'SEC-Q-2 pending 대조군'
    );

    v_all_center_ids := coalesce(v_p3_remove_ids, '{}') || coalesce(v_secmc_ids, '{}');
    v_target_count := coalesce(array_length(v_all_center_ids, 1), 0);
    raise notice '[B] 삭제 대상 centers: %건 (P3 중복분 %건 + SEC-계열 전부 %건), 보존되는 P3 대표행: %',
        v_target_count, coalesce(array_length(v_p3_remove_ids,1),0), coalesce(array_length(v_secmc_ids,1),0), v_p3_keep_ids;

    -- 가드 1: 상한. [2026-08-14 재조정] A-4 실측 결과 'P3 타센터-격리테스트' 295건 +
    -- 'P3 통합-타센터' 82건 = 377건이 이미 확인됐다(GitHub Actions cancel-in-progress로
    -- 거의 매 실행마다 afterAll이 못 돌았던 것으로 추정, 2026-08-06~08-12). 원래 200은
    -- 이 실측치보다 낮아 정상적인 정리 시도까지 막아버리므로 2000으로 올린다 — 그래도
    -- "진짜 이상 급증"(예: 조건이 실제 데이터와 어긋나 엉뚱한 대량 행을 잡음)은 여전히 걸러낸다.
    if v_target_count > 2000 then
        raise exception '[B] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_target_count;
    end if;

    if v_target_count = 0 then
        raise notice '[B] 삭제 대상이 0건입니다 — 스킵합니다(이미 정리되었거나 조건이 실제 데이터와 어긋남).';
    else
        -- FK 순서: manager_centers → center_roles → products → centers
        delete from manager_centers where center_id = any(v_all_center_ids);
        get diagnostics v_deleted_mc = row_count;

        delete from center_roles where center_id = any(v_all_center_ids);
        get diagnostics v_deleted_roles = row_count;

        delete from products where center_id = any(v_all_center_ids);
        get diagnostics v_deleted_prod = row_count;

        delete from centers where id = any(v_all_center_ids);
        get diagnostics v_deleted_centers = row_count;

        raise notice '[B] 실제 삭제: manager_centers %건, center_roles %건, products %건, centers %건',
            v_deleted_mc, v_deleted_roles, v_deleted_prod, v_deleted_centers;

        if v_deleted_centers <> v_target_count then
            raise exception '[B] 삭제된 centers 수(%건)가 대상 건수(%건)와 다릅니다 — 롤백합니다.', v_deleted_centers, v_target_count;
        end if;
    end if;

    -- 가드 2: 정리 후 P3 계열은 이름당 정확히 1건(또는 0건, 아직 테스트가 한 번도 안 돈
    -- 경우), SEC-계열은 0건이어야 함.
    select count(*) into v_remaining_after
    from centers
    where name in (
        'SEC-D/K 부트스트랩 테스트센터', 'SEC-J 타센터 role 탈취용',
        'SEC-Q orphan(approved) 재현용', 'SEC-Q-2 pending 대조군'
    );
    if v_remaining_after <> 0 then
        raise exception '[B] SEC-계열 정리 후에도 %건 남아 있습니다 — 롤백합니다.', v_remaining_after;
    end if;

    if exists (
        select 1 from (
            select name, count(*) as c from centers
            where name in ('P3 타센터-격리테스트', 'P3 통합-타센터')
            group by name
        ) y where y.c > 1
    ) then
        raise exception '[B] P3 계열 정리 후에도 이름당 중복이 남아 있습니다 — 롤백합니다.';
    end if;

    raise notice '[B] 검증 전부 통과 — COMMIT 진행';
end $$;

COMMIT;


-- ============================================================
-- C. POST-COMMIT VERIFICATION — B가 COMMIT된 뒤 별도로 실행해서 확인
-- ============================================================

-- C-1. 이름별 최종 건수(P3 계열은 0 또는 1, SEC-계열은 반드시 0)
select name, count(*) as row_count
from centers
where name in (
    'P3 타센터-격리테스트', 'P3 통합-타센터',
    'SEC-D/K 부트스트랩 테스트센터', 'SEC-J 타센터 role 탈취용',
    'SEC-Q orphan(approved) 재현용', 'SEC-Q-2 pending 대조군'
)
group by name
order by name;

-- C-2. products 쪽도 함께 정리됐는지(고아 products가 없는지)
select id, center_id, name from products
where name in ('P3 타센터전용패스', 'P3 통합-타센터패스')
  and center_id not in (select id from centers);
