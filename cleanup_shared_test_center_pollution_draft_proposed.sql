-- ============================================================
-- 공유 통합/E2E 테스트 센터(managerA 소유)의 누적 오염 정리
--
-- 배경: class-allowed-products.spec.ts가 최근 CI에서 간헐적으로 실패(타임아웃/개수 불일치)
-- 해 원인을 읽기 전용 진단(tests/integration/_diag_pollution.test.ts, CI run 31268325509)
-- 으로 직접 조회했다. 대상 센터는 TEST_MANAGER_A 계정이 소유한 단 하나의 통합/E2E 공용
-- 테스트 센터(대부분의 integration/e2e 테스트가 getOrCreateOwnedTestCenter(managerA)로
-- 재사용) — TEST_MANAGER_A는 실제 운영에 전혀 쓰이지 않는 전용 테스트 계정이므로, 이
-- 센터의 데이터는 성격상 전부 테스트 전용이다.
--
-- 진단 결과(핵심):
--   - memberships (center_id=이 센터): PostgREST 기본 1000행 응답 캡에 걸릴 만큼 누적.
--     캡 안에서만도 product_name="통합테스트 수강권" 979건, "P0-6 테스트 무제한권" 15건,
--     "USABLE-PASS-KIND 테스트 대여품" 6건 — 전부 profile_id가 userA 또는 managerA
--     둘 중 하나였다(그 외 profile_id는 0건, 진단으로 직접 확인).
--   - products (center_id=이 센터, 66건): "USABLE-PASS-KIND 테스트 대여품"(goods) 45건이
--     get-or-create 없이(afterAll 정리 의존) 계속 새로 생성됐다. "P3 패스A~F"/"P3 통합-*"/
--     "P4 통합-*"/"E2E 테스트 수강권 상품"/"E2E 테스트 대여품 상품"은 이미 get-or-create로
--     정확히 1건씩만 있어 정리 대상이 아니다 — 이 스크립트는 절대 건드리지 않는다.
--   - profiles (userA 계정 산하, 16건): is_primary=false, name="P3 출결-대기용" —
--     tests/e2e/admin/attendance.spec.ts가 대기(waitlist) 시나리오용으로 만든 임시 프로필이
--     afterAll에서 지워지게 돼 있었지만, CI가 그 spec 도중 취소되면(GitHub Actions
--     concurrency.cancel-in-progress, 또는 사람이 새 실행을 다시 트리거) afterAll 자체가
--     실행되지 않아 계속 쌓였다.
--
-- 근본 원인(코드도 함께 고침, 이 SQL과 같은 커밋): createTestMembership()(setup.ts),
-- createTestMembershipAdmin()/createTestGoodsMembershipAdmin()(testData.ts),
-- class-allowed-products-enforcement.test.ts의 로컬 createMembershipForProduct(),
-- usable-memberships-pass-kind.test.ts의 인라인 상품/수강권 생성 — 전부 get-or-create +
-- self-healing refresh로 바꿔서 앞으로는 이 정리가 다시 필요하지 않도록 했다. 이 SQL은
-- "지금까지 이미 쌓인 것"의 1회성 정리다.
--
-- 안전장치:
--   - 정확히 이 센터(center_id 하드코딩, 아래 근거)로만 범위를 좁힌다.
--   - memberships/신규 profiles는 정확히 이 두 계정(TEST_MANAGER_A/TEST_USER_A)의
--     profile_id로만 좁힌다 — 진단으로 "그 외 profile_id 0건"을 직접 확인했다.
--   - product_name/프로필 name이 테스트 전용임을 코드로 확인할 수 있는 정확한 문자열과
--     완전히 일치하는 행만 대상으로 한다(부분 일치 없음).
--   - 각 삭제 전 미리보기 SELECT + 예상 범위를 벗어나면 즉시 RAISE EXCEPTION(전체 롤백).
--   - FK 안전 순서: payments → reservations → memberships → products → profiles.
--   - "P3 패스A~F" 등 이미 get-or-create로 정상 관리되는 상품/그 상품의 memberships,
--     그리고 classes/class_allowed_products/reservations(다른 파일들의 대량 누적 — 별도
--     이슈로 docs/TODO.md에 기록, 이 스크립트의 범위 밖)는 전혀 건드리지 않는다.
--
-- 대상 center_id: 3937eb89-3803-43e9-9a29-e893f779df1a
--   (getOrCreateOwnedTestCenter(managerA) 실행 결과로 CI에서 직접 확인, run 31268325509)
-- 대상 profile_id: userA=bf0939f6-d676-43bd-a164-c021ad623063,
--                   managerA=689fd564-40d2-4c39-a687-5b6a6b220fbd
-- 대상 account_id(고아 프로필용): userA=0058f5bc-9fe8-4b22-bd96-1ce011290e19
--
-- ⚠ 실행 전 반드시: 아래 [0] 미리보기 결과에서 center 이름이 실제로 테스트센터처럼 보이는지
-- (예: "통합테스트센터-..." 등, 실제 운영 센터명이 아닌지) 육안으로 확인한 뒤 진행하세요.
-- ============================================================

-- [0] 대상 센터 확인 — 반드시 먼저 실행해서 이름을 눈으로 확인
select id, name, status, created_at from centers where id = '3937eb89-3803-43e9-9a29-e893f779df1a';

BEGIN;

-- [1] "P3 출결-대기용" 고아 프로필 + 그 예약/수강권 (attendance.spec.ts 취소 시 afterAll 미실행)
do $$
declare
  v_ids uuid[];
  v_count int;
begin
  select array_agg(id) into v_ids
    from profiles
   where account_id = '0058f5bc-9fe8-4b22-bd96-1ce011290e19'
     and is_primary = false
     and name = 'P3 출결-대기용';
  v_count := coalesce(array_length(v_ids, 1), 0);
  raise notice '[1] 고아 프로필(P3 출결-대기용) 대상: %건', v_count;
  if v_count > 200 then
    raise exception '[1] 예상보다 훨씬 많음(%건, 진단 시점 16건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;
  if v_count > 0 then
    delete from reservations where profile_id = any(v_ids);
    delete from payments where profile_id = any(v_ids);
    delete from memberships where profile_id = any(v_ids);
    delete from profiles where id = any(v_ids);
  end if;
end $$;

-- [2] product_name="통합테스트 수강권"(product_id is null) — setup.ts의 createTestMembership()
do $$
declare
  v_count int;
begin
  select count(*) into v_count from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_id is null
     and product_name = '통합테스트 수강권'
     and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd');
  raise notice '[2] "통합테스트 수강권" 대상: %건', v_count;
  if v_count < 500 then
    raise exception '[2] 예상보다 훨씬 적음(%건, 진단 시점 979건 이상) — 조건이 잘못됐을 수 있습니다. 중단합니다.', v_count;
  end if;
  if v_count > 50000 then
    raise exception '[2] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;
  delete from payments where membership_id in (
    select id from memberships
     where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
       and product_id is null and product_name = '통합테스트 수강권'
       and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
  );
  delete from reservations where membership_id in (
    select id from memberships
     where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
       and product_id is null and product_name = '통합테스트 수강권'
       and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
  );
  delete from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_id is null and product_name = '통합테스트 수강권'
     and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd');
end $$;

-- [3] product_name="통합테스트 수강권(P3)" — class-allowed-products-enforcement.test.ts 로컬 헬퍼
do $$
declare
  v_count int;
begin
  select count(*) into v_count from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_name = '통합테스트 수강권(P3)'
     and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd');
  raise notice '[3] "통합테스트 수강권(P3)" 대상: %건', v_count;
  if v_count > 5000 then
    raise exception '[3] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;
  if v_count > 0 then
    delete from payments where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_name = '통합테스트 수강권(P3)'
         and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
    );
    delete from reservations where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_name = '통합테스트 수강권(P3)'
         and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
    );
    delete from memberships
     where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
       and product_name = '통합테스트 수강권(P3)'
       and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd');
  end if;
end $$;

-- [4] product_name="P0-6 테스트 무제한권" — 현재 tests/ 소스에 더 이상 존재하지 않는(리팩터링/삭제된)
-- 옛 테스트가 남긴 고아 데이터(코드는 이미 없어졌지만 DB 행만 남음).
do $$
declare
  v_count int;
begin
  select count(*) into v_count from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_name = 'P0-6 테스트 무제한권'
     and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd');
  raise notice '[4] "P0-6 테스트 무제한권" 대상: %건', v_count;
  if v_count > 500 then
    raise exception '[4] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;
  if v_count > 0 then
    delete from payments where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_name = 'P0-6 테스트 무제한권'
         and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
    );
    delete from reservations where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_name = 'P0-6 테스트 무제한권'
         and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
    );
    delete from memberships
     where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
       and product_name = 'P0-6 테스트 무제한권'
       and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd');
  end if;
end $$;

-- [5] "USABLE-PASS-KIND 테스트 대여품" — usable-memberships-pass-kind.test.ts, get-or-create
-- 없이 매 실행 새 products 행을 만들던 것(45건 확인). memberships → products 순.
do $$
declare
  v_product_count int;
begin
  select count(*) into v_product_count from products
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and name = 'USABLE-PASS-KIND 테스트 대여품' and product_kind = 'goods';
  raise notice '[5] "USABLE-PASS-KIND 테스트 대여품" 상품 대상: %건', v_product_count;
  if v_product_count > 2000 then
    raise exception '[5] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_product_count;
  end if;
  if v_product_count > 0 then
    delete from payments where membership_id in (
      select id from memberships where product_id in (
        select id from products
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and name = 'USABLE-PASS-KIND 테스트 대여품' and product_kind = 'goods'
      )
    );
    delete from reservations where membership_id in (
      select id from memberships where product_id in (
        select id from products
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and name = 'USABLE-PASS-KIND 테스트 대여품' and product_kind = 'goods'
      )
    );
    delete from memberships where product_id in (
      select id from products
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and name = 'USABLE-PASS-KIND 테스트 대여품' and product_kind = 'goods'
    );
    delete from products
     where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
       and name = 'USABLE-PASS-KIND 테스트 대여품' and product_kind = 'goods';
  end if;
end $$;

COMMIT;

-- ============================================================
-- 확인 — 실행 후 남은 행 수(0건이어야 정상, [1]은 이후 다시 attendance.spec.ts를 돌리면
-- 정상적으로 재생성됨)
-- ============================================================
select count(*) as remaining_orphan_profiles from profiles
 where account_id = '0058f5bc-9fe8-4b22-bd96-1ce011290e19' and is_primary = false and name = 'P3 출결-대기용';
select count(*) as remaining_통합테스트_수강권 from memberships
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a' and product_id is null and product_name = '통합테스트 수강권';
select count(*) as remaining_통합테스트_수강권_p3 from memberships
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a' and product_name = '통합테스트 수강권(P3)';
select count(*) as remaining_p0_6 from memberships
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a' and product_name = 'P0-6 테스트 무제한권';
select count(*) as remaining_usable_pass_kind_products from products
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a' and name = 'USABLE-PASS-KIND 테스트 대여품';
select count(*) as remaining_memberships_total from memberships where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
