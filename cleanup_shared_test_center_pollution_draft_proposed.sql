-- ============================================================
-- 공유 통합/E2E 테스트 센터(managerA 소유)의 누적 오염 정리 — v2 (FK 의존성 전수 재감사)
--
-- v1 실행 결과: "update or delete on table memberships violates foreign key constraint
-- admin_action_logs_membership_id_fkey" — admin_action_logs(add_admin_assignment.sql)가
-- memberships/reservations/profiles를 참조하는데 v1이 이를 놓쳤다. 트랜잭션이라 v1은 전부
-- 롤백됨(재진단으로 직접 확인 — 실행 후에도 orphan profile/"통합테스트 수강권" 건수가
-- 변화 없음, run 31270744749).
--
-- FK 의존성 전수 재감사(schema.sql + add_admin_assignment.sql 코드 감사, 이번에 새로 확인):
-- memberships(id)/profiles(id)를 references하면서 on delete cascade/set null이 *아닌*
-- (=삭제 시 직접 막는) 테이블은 다음과 같다.
--   - admin_action_logs: reservation_id(not null), member_profile_id(not null),
--     membership_id(null 허용), source_unassigned_id(null 허용), class_id(not null, 이번
--     정리 대상 아님)
--   - membership_transfers: membership_id(not null), from_profile_id/to_profile_id(not null)
--   - product_passes: linked_membership_id(null 허용), profile_id(not null)
--   - contracts: membership_id(null 허용), profile_id(not null)
--   - locker_assignments: profile_id(not null)
--   - point_transactions: profile_id(not null) — 이름은 point_transactions이지만 실제
--     칼럼명은 스키마 확인 필요(존재 시에만 삭제, 아래 DO 블록에서 to_regclass로 방어)
--   - progress_records: profile_id(not null)
-- (payments.membership_id는 이미 v1에서 처리됨 — memberships/reservations보다 먼저 삭제)
-- 추가로 point_transactions.payment_id(not null 아님, on delete 지정 없음)가 payments를
-- 참조하므로, payments를 지우기 전에 그 payments를 가리키는 point_transactions도 먼저 지운다.
--
-- 이 정리가 실제로 건드리는 프로필은 userA/managerA의 "실제 프로필 자체"가 아니라 그
-- 프로필들이 만든 *테스트 전용 memberships*, 그리고 attendance.spec.ts가 만든 *고아
-- sub-profile*(is_primary=false) 뿐이다 — 그래서 위 표에서 "profile_id" 계열 FK는
-- 고아 sub-profile을 지울 때만 문제가 되고, membership 계열 정리에서는 문제가 되지 않는다
-- (userA/managerA의 진짜 profiles 행 자체는 이 스크립트가 전혀 삭제하지 않음).
--
-- admin_action_logs만은 예외 취급: 진단 쿼리로 정확한 참조 건수를 셀 수 없었다(service_role이
-- 이 7개 테이블 전부에 대한 SQL GRANT 자체가 없어 PostgREST로 조회 불가 — add_admin_assignment.sql이
-- GRANT를 추가하지 않음, docs/TODO.md P2-13과 같은 계열의 별도 gap). 대신 center_id 하나로
-- 완전히 좁혀서(대상 센터는 TEST_MANAGER_A 전용 테스트 센터라 이 안의 모든 admin_action_logs
-- 행은 성격상 100% 테스트 실행이 남긴 것) 그 센터의 admin_action_logs를 통째로 먼저 지운다 —
-- 부분적으로 어떤 행만 골라 지우는 것보다 이쪽이 더 간단하고 안전하다(막연히 "관련된 것만"
-- 추측해서 놓치는 대신, 이 센터 소속이면 전부 테스트 로그라는 구조적 근거로 통째 처리).
--
-- 안전장치(v1과 동일 + 추가):
--   - center_id 하드코딩(아래 근거)로만 범위를 좁힌다.
--   - memberships/신규 profiles는 정확히 이 두 계정(TEST_MANAGER_A/TEST_USER_A)의
--     profile_id로만 좁힌다 — 진단으로 "그 외 profile_id 0건" 확인.
--   - product_name/프로필 name이 정확히 일치하는 행만 대상(부분 일치 없음).
--   - 각 삭제 전 미리보기 SELECT + 예상 범위를 벗어나면 즉시 RAISE EXCEPTION(전체 롤백).
--   - FK 안전 순서: admin_action_logs → (membership_transfers/product_passes/contracts/
--     locker_assignments/point_transactions/progress_records, 대상에 한해) → payments →
--     reservations → memberships → products → profiles.
--   - 각 보조 테이블은 to_regclass로 실존 여부를 먼저 확인해, 이 개발 DB에 아직 없는 테이블
--     (예: point_transactions이 실제로는 다른 이름일 수 있음)이 있어도 에러 없이 건너뛴다.
--   - classes/class_allowed_products/reservations의 다른 파일발 대량 누적(별도 이슈,
--     docs/TODO.md P2-19)은 여전히 범위 밖 — 건드리지 않음.
--
-- 대상 center_id: 3937eb89-3803-43e9-9a29-e893f779df1a
--   (getOrCreateOwnedTestCenter(managerA) 실행 결과로 CI에서 직접 확인, run 31268325509)
-- 대상 profile_id: userA=bf0939f6-d676-43bd-a164-c021ad623063,
--                   managerA=689fd564-40d2-4c39-a687-5b6a6b220fbd
-- 대상 account_id(고아 프로필용): userA=0058f5bc-9fe8-4b22-bd96-1ce011290e19
--
-- ⚠ 실행 전 반드시: 아래 [0] 미리보기 결과에서 center 이름이 실제로 테스트센터처럼 보이는지
-- 육안으로 확인한 뒤 진행하세요.
-- ============================================================

-- [0] 대상 센터 확인 — 반드시 먼저 실행해서 이름을 눈으로 확인
select id, name, status, created_at from centers where id = '3937eb89-3803-43e9-9a29-e893f779df1a';

BEGIN;

-- [1] admin_action_logs — 이 센터 소속 전부(구조적으로 100% 테스트 로그, 위 설명 참고).
-- 반드시 reservations/memberships/profiles 삭제보다 먼저 실행(그 세 테이블을 참조하므로).
do $$
declare
  v_count int;
begin
  select count(*) into v_count from admin_action_logs where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
  raise notice '[1] admin_action_logs(centerA 소속) 대상: %건', v_count;
  if v_count > 20000 then
    raise exception '[1] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;
  delete from admin_action_logs where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
end $$;

-- [2] "P3 출결-대기용" 고아 프로필 + 그 예약/수강권/보조 테이블 참조 (attendance.spec.ts 취소 시 afterAll 미실행)
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
  raise notice '[2] 고아 프로필(P3 출결-대기용) 대상: %건', v_count;
  if v_count > 200 then
    raise exception '[2] 예상보다 훨씬 많음(%건, 진단 시점 최대 16건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;
  if v_count > 0 then
    if to_regclass('public.membership_transfers') is not null then
      delete from membership_transfers where from_profile_id = any(v_ids) or to_profile_id = any(v_ids);
    end if;
    if to_regclass('public.product_passes') is not null then
      delete from product_passes where profile_id = any(v_ids);
    end if;
    if to_regclass('public.contracts') is not null then
      delete from contracts where profile_id = any(v_ids);
    end if;
    if to_regclass('public.locker_assignments') is not null then
      delete from locker_assignments where profile_id = any(v_ids);
    end if;
    if to_regclass('public.point_transactions') is not null then
      delete from point_transactions where profile_id = any(v_ids);
    end if;
    if to_regclass('public.progress_records') is not null then
      delete from progress_records where profile_id = any(v_ids);
    end if;
    delete from reservations where profile_id = any(v_ids);
    delete from payments where profile_id = any(v_ids);
    delete from memberships where profile_id = any(v_ids);
    delete from profiles where id = any(v_ids);
  end if;
end $$;

-- [3] product_name="통합테스트 수강권"(product_id is null) — setup.ts의 createTestMembership()
do $$
declare
  v_count int;
begin
  select count(*) into v_count from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_id is null
     and product_name = '통합테스트 수강권'
     and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd');
  raise notice '[3] "통합테스트 수강권" 대상: %건', v_count;
  if v_count < 500 then
    raise exception '[3] 예상보다 훨씬 적음(%건, 진단 시점 2525건) — 조건이 잘못됐을 수 있습니다. 중단합니다.', v_count;
  end if;
  if v_count > 50000 then
    raise exception '[3] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;

  if to_regclass('public.membership_transfers') is not null then
    delete from membership_transfers where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_id is null and product_name = '통합테스트 수강권'
         and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
    );
  end if;
  if to_regclass('public.product_passes') is not null then
    delete from product_passes where linked_membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_id is null and product_name = '통합테스트 수강권'
         and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
    );
  end if;
  if to_regclass('public.contracts') is not null then
    delete from contracts where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_id is null and product_name = '통합테스트 수강권'
         and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
    );
  end if;

  if to_regclass('public.point_transactions') is not null then
    delete from point_transactions where payment_id in (
      select id from payments where membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_id is null and product_name = '통합테스트 수강권'
           and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
      )
    );
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

-- [4] product_name="통합테스트 수강권(P3)" — class-allowed-products-enforcement.test.ts 로컬 헬퍼
do $$
declare
  v_count int;
begin
  select count(*) into v_count from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_name = '통합테스트 수강권(P3)'
     and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd');
  raise notice '[4] "통합테스트 수강권(P3)" 대상: %건', v_count;
  if v_count > 5000 then
    raise exception '[4] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;
  if v_count > 0 then
    if to_regclass('public.membership_transfers') is not null then
      delete from membership_transfers where membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_name = '통합테스트 수강권(P3)'
           and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
      );
    end if;
    if to_regclass('public.product_passes') is not null then
      delete from product_passes where linked_membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_name = '통합테스트 수강권(P3)'
           and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
      );
    end if;
    if to_regclass('public.contracts') is not null then
      delete from contracts where membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_name = '통합테스트 수강권(P3)'
           and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
      );
    end if;
    if to_regclass('public.point_transactions') is not null then
      delete from point_transactions where payment_id in (
        select id from payments where membership_id in (
          select id from memberships
           where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
             and product_name = '통합테스트 수강권(P3)'
             and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
        )
      );
    end if;
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

-- [5] product_name="P0-6 테스트 무제한권" — 현재 tests/ 소스에 더 이상 존재하지 않는(리팩터링/삭제된)
-- 옛 테스트가 남긴 고아 데이터.
do $$
declare
  v_count int;
begin
  select count(*) into v_count from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_name = 'P0-6 테스트 무제한권'
     and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd');
  raise notice '[5] "P0-6 테스트 무제한권" 대상: %건', v_count;
  if v_count > 500 then
    raise exception '[5] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;
  if v_count > 0 then
    if to_regclass('public.membership_transfers') is not null then
      delete from membership_transfers where membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_name = 'P0-6 테스트 무제한권'
           and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
      );
    end if;
    if to_regclass('public.product_passes') is not null then
      delete from product_passes where linked_membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_name = 'P0-6 테스트 무제한권'
           and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
      );
    end if;
    if to_regclass('public.contracts') is not null then
      delete from contracts where membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_name = 'P0-6 테스트 무제한권'
           and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
      );
    end if;
    if to_regclass('public.point_transactions') is not null then
      delete from point_transactions where payment_id in (
        select id from payments where membership_id in (
          select id from memberships
           where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
             and product_name = 'P0-6 테스트 무제한권'
             and profile_id in ('bf0939f6-d676-43bd-a164-c021ad623063', '689fd564-40d2-4c39-a687-5b6a6b220fbd')
        )
      );
    end if;
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

-- [6] "USABLE-PASS-KIND 테스트 대여품" — usable-memberships-pass-kind.test.ts, get-or-create
-- 없이 매 실행 새 products 행을 만들던 것. memberships → products 순.
do $$
declare
  v_product_count int;
begin
  select count(*) into v_product_count from products
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and name = 'USABLE-PASS-KIND 테스트 대여품' and product_kind = 'goods';
  raise notice '[6] "USABLE-PASS-KIND 테스트 대여품" 상품 대상: %건', v_product_count;
  if v_product_count > 2000 then
    raise exception '[6] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_product_count;
  end if;
  if v_product_count > 0 then
    if to_regclass('public.membership_transfers') is not null then
      delete from membership_transfers where membership_id in (
        select id from memberships where product_id in (
          select id from products
           where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
             and name = 'USABLE-PASS-KIND 테스트 대여품' and product_kind = 'goods'
        )
      );
    end if;
    if to_regclass('public.product_passes') is not null then
      delete from product_passes where linked_membership_id in (
        select id from memberships where product_id in (
          select id from products
           where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
             and name = 'USABLE-PASS-KIND 테스트 대여품' and product_kind = 'goods'
        )
      );
    end if;
    if to_regclass('public.contracts') is not null then
      delete from contracts where membership_id in (
        select id from memberships where product_id in (
          select id from products
           where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
             and name = 'USABLE-PASS-KIND 테스트 대여품' and product_kind = 'goods'
        )
      );
    end if;
    if to_regclass('public.point_transactions') is not null then
      delete from point_transactions where payment_id in (
        select id from payments where membership_id in (
          select id from memberships where product_id in (
            select id from products
             where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
               and name = 'USABLE-PASS-KIND 테스트 대여품' and product_kind = 'goods'
          )
        )
      );
    end if;
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
-- 확인 — 실행 후 남은 행 수(0건이어야 정상, [2]는 이후 다시 attendance.spec.ts를 돌리면
-- 정상적으로 재생성됨)
-- ============================================================
select count(*) as remaining_admin_action_logs from admin_action_logs where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
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
