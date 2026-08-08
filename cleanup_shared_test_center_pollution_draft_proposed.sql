-- ============================================================
-- 공유 통합/E2E 테스트 센터(managerA 소유)의 누적 오염 정리 — v4 (profile_id 제한 제거)
--
-- v3 실행 결과: FK 오류는 재발하지 않았지만(=[L] 락 + admin_action_logs 처리가 실제로
-- 문제를 해결함), [3]의 새 guard에서 안전하게 중단됨 — "예상보다 훨씬 적음(0건, 진단
-- 시점 2525건)". 재진단(read-only, CI diag_only 모드로 e2e/unit/integration/build는
-- 건드리지 않고 확인)한 결과(코드로 직접 확인, 추측 아님):
--   1) product_name 텍스트 자체는 문제가 아니었다 — utf8 바이트 단위로 비교해 DB에 저장된
--      값과 이 SQL의 리터럴이 완전히 동일함을 확인함(hex: ed86b5ed95a9ed858cec8aa4ed8ab8
--      20ec8898eab095eab68c, 양쪽 동일). 유니코드 정규화 문제 아님.
--   2) 진단 시점(v2 실패 직후) "통합테스트 수강권"(product_id is null) 전체 모집단은
--      2525건, 그중 userA=512/managerA=488건이었다. 그런데 v3를 실행한 시점에는 이
--      모집단이 168건으로 줄어 있었고, 전부(168/168) userA도 managerA도 아닌 세 번째
--      profile_id(f2c9749a-b282-433b-8b60-a982b81a53f3)에 속해 있었다 — v3의
--      `profile_id in (userA, managerA)` 조건이 이 시점엔 실제로 0건과 일치했다(버그가
--      아니라 guard가 정확히 설계대로 동작해 "예상과 다른 상태"를 잡아낸 것).
--   3) 그 세 번째 profile_id를 profiles 테이블에서 직접 조회해 교차검증함:
--      account_id=e241ce33-8419-4b3f-bba8-36a5a543de47, name="통합테스트"(userA/managerA의
--      기본 프로필과 동일한 get-or-create 테스트 계정 명명 패턴), is_primary=true,
--      created_at=2026-07-30(이 세션의 다른 테스트 계정들과 같은 시기) — userA/managerA와
--      다른 계정이지만 성격은 동일한 전용 테스트 계정의 기본 프로필이다(실제 사용자 아님).
--      accounts 테이블은 service_role SQL GRANT가 없어(payments/admin_action_logs와 같은
--      계열의 별도 gap, docs/TODO.md에 기록 예정) 계정명까지는 확인 못 했지만, profiles의
--      명명 패턴과 생성 시점만으로도 이 세션의 다른 TEST_* 계정과 동일한 성격임이 충분히
--      확인됨.
--   4) 결론: "통합테스트 수강권"(product_id is null) 모집단은 시점에 따라 여러 TEST_*
--      계정의 profile_id 사이를 오간다(이 공유 dev DB를 여러 통합테스트 파일·때로는 이
--      저장소의 다른 worktree/세션이 동시에 쓰기 때문 — 조사 도중에도 실제로 값이
--      바뀌는 것을 두 번 관측함). 애초에 "userA/managerA 두 profile_id로만 좁힌다"는
--      v1~v3의 조건 자체가 과도하게 좁았다 — 이 product_name 문자열은
--      tests/integration/setup.ts의 createTestMembership() 하나만 쓰고(grep으로 재확인,
--      다른 어떤 앱 코드도 이 정확한 문자열을 쓰지 않음), 그 헬퍼는 언제나 테스트 전용
--      account/profile에만 호출된다 — 그래서 안전 근거는 애초부터 "이 정확한 문자열 +
--      이 특정 center_id + product_id is null"이었고 profile_id 제한은 불필요했다(오히려
--      이번처럼 실제 모집단과 어긋나면 정리를 막기만 함). v4는 [3]/[4]/[5]에서 profile_id
--      제한을 제거하고, 그 대신 이제는 시점마다 달라질 수 있는 하한(< 500) guard도
--      제거한다(상한 guard로 "터무니없이 큰 값"만 계속 방어) — 개수 자체가 아니라
--      "정확한 문자열 + 정확한 center_id"라는 구조적 근거로 안전을 보장한다.
--
-- v3 이하 이력(v1/v2 실패 원인, [L] 락 설계):
-- v1 실행 결과: "update or delete on table memberships violates foreign key constraint
-- admin_action_logs_membership_id_fkey" — admin_action_logs(add_admin_assignment.sql)가
-- memberships/reservations/profiles를 참조하는데 v1이 이를 놓쳤다. 트랜잭션이라 v1은 전부
-- 롤백됨(재진단으로 직접 확인 — 실행 후에도 orphan profile/"통합테스트 수강권" 건수가
-- 변화 없음, run 31270744749).
--
-- v2 실행 결과: admin_action_logs를 먼저 지우는 로직을 추가했는데도 *같은* FK 오류가
-- 재발함(membership 19cdd08e-e0af-43e7-8ea0-706616a671ec를 참조하는 admin_action_logs
-- 2행). SQL 구조 자체를 재감사한 결과(코드로 직접 확인, 추측 아님):
--   - v2의 5개 do 블록 전부 EXCEPTION 핸들러가 없어, 블록 하나가 실패하면 트랜잭션
--     전체가 롤백된다 — v2가 v1과 "같은 FK 오류"로 실패했다는 것은 [1]의 admin_action_logs
--     DELETE 자체는 에러 없이 끝까지 실행됐다는 뜻이다(내 커스텀 RAISE EXCEPTION도 아니었음).
--   - 즉 [1]이 실행되던 시점엔 그 2행이 없었거나 지워졌지만, 그 뒤 [3]의 memberships
--     DELETE가 실행되던 시점에는 다시 존재했다 — WHERE절 오타나 타입 문제가 아니라
--     (v1과 동일 패턴의 리터럴이고 정확히 그 center_id로 확인됨), 두 DELETE 문 "사이"에
--     새로 생긴 것이다.
--   - 코드로 직접 확인한 원인: setup.ts의 createTestMembership()을 get-or-create로 고친
--     이번 배치 이후, tests/integration/admin-assignment-security.test.ts의 "성공경로-*"
--     테스트들이 매번 *같은* (userA, centerA) memberships 행을 재사용하게 됐다. 그 파일의
--     각 테스트는 admin_assign_reservation(admin_action_logs 1행 insert,
--     add_admin_assignment.sql:307-322)과 admin_cancel_reservation(admin_action_logs 1행
--     insert, add_admin_assignment.sql:394-409)을 순서대로 호출해 그 재사용 membership에
--     정확히 2행을 남긴다 — 발견된 "정확히 2행"과 일치. Postgres 기본 격리수준(READ
--     COMMITTED)에서는 트랜잭션 안의 각 문장이 "그 문장이 실행되는 시점"까지 다른 세션이
--     커밋한 내용을 본다 — 그래서 [1]과 [3] 사이에 다른 세션(동시에 돌던 CI, 이번 세션이
--     반복 트리거한 것 포함)이 이 재사용 membership에 admin_action_logs를 새로 insert하면
--     [3]에서 그 새 행이 FK 위반을 낸다. 단순 검증(SELECT 후 확인)만으로는 검증과 삭제
--     "사이"에도 같은 틈이 남으므로, v3는 트랜잭션 시작 시 관련 테이블에 LOCK TABLE을 걸어
--     그 틈 자체를 구조적으로 없앤다(아래 [L] 참고).
--
-- v1/v2 모두 완전히 롤백됐음을 재확인(2026-08-09, run 31271322462): "통합테스트 수강권"
-- 건수가 v1 직후·v2 시도 전후 세 번의 진단에서 전부 동일하게 2525건, orphan profile은
-- self-healing 코드가 배포된 뒤 실행된 CI 덕분에 16→1로 감소(정리 SQL과 무관, 코드 수정
-- 효과) — 두 시도 모두 부분 반영 없이 전체 롤백된 것을 직접 확인.
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
-- 안전장치(v1/v2와 동일 + v3 추가분):
--   - (v3 신규) 트랜잭션 시작 시 admin_action_logs/memberships/reservations/payments/
--     profiles에 SHARE ROW EXCLUSIVE 락을 걸어, 트랜잭션이 끝날 때까지 다른 세션의
--     INSERT/UPDATE/DELETE를 차단한다 — v2가 실패한 "검증 시점과 삭제 시점 사이의 동시
--     쓰기" 자체를 구조적으로 없앤다.
--   - (v3 신규) admin_action_logs 삭제 직후 즉시 재확인(0건이 아니면 그 자리에서 중단).
--   - (v4 변경) [3]/[4]/[5](memberships 정리)의 profile_id 제한을 제거했다 — 위 4)번
--     설명대로 이 product_name 문자열은 애초에 profile_id와 무관하게 그 자체로
--     테스트 전용임이 코드로 확인됐고(오직 createTestMembership() 하나만 이 문자열을
--     씀), userA/managerA 두 계정으로만 좁히는 게 오히려 실제 모집단과 어긋나 정리를
--     막았다. [2](고아 프로필)는 여전히 userA의 account_id로 좁힌다(그 헬퍼의 동작상
--     항상 그 계정 산하에만 생기므로 유효).
--   - center_id 하드코딩(아래 근거)로만 범위를 좁힌다.
--   - product_name/프로필 name이 정확히 일치하는 행만 대상(부분 일치 없음).
--   - 각 삭제 전 미리보기 SELECT + (v4) 상한만 남긴 RAISE EXCEPTION(전체 롤백) — 하한은
--     시점마다 달라지는 모집단 크기 자체를 안전 근거로 쓰지 않기 위해 제거함(위 4)번).
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
-- 대상 account_id(고아 프로필용, [2]에서만 사용): userA=0058f5bc-9fe8-4b22-bd96-1ce011290e19
-- ([3]/[4]/[5]는 v4부터 profile_id로 좁히지 않음 — 위 설명 참고)
--
-- ⚠ 실행 전 반드시: 아래 [0] 미리보기 결과에서 center 이름이 실제로 테스트센터처럼 보이는지
-- 육안으로 확인한 뒤 진행하세요.
-- ============================================================

-- [0] 대상 센터 확인 — 반드시 먼저 실행해서 이름을 눈으로 확인
select id, name, status, created_at from centers where id = '3937eb89-3803-43e9-9a29-e893f779df1a';

BEGIN;

-- [L] 동시 쓰기 차단 — v2 실패의 실제 원인(위 설명 참고). 이 트랜잭션이 끝날 때까지 다른
-- 세션이 이 테이블들에 INSERT/UPDATE/DELETE(admin_assign_reservation/admin_cancel_reservation
-- 등 security definer RPC 호출 포함)를 하지 못하도록 막는다 — 그 세션들은 이 트랜잭션이
-- COMMIT/ROLLBACK될 때까지 그냥 대기한다(에러 아님). 이러면 "검증 시점"과 "삭제 시점"
-- 사이의 틈 자체가 사라진다. 이 락은 SQL Editor 세션이 실제로 이 트랜잭션의 소유자일
-- 때만 유효하다(다른 연결이 같은 테이블에 접근하려는 순간부터 대기 상태가 됨).
lock table admin_action_logs in share row exclusive mode;
lock table memberships in share row exclusive mode;
lock table reservations in share row exclusive mode;
lock table payments in share row exclusive mode;
lock table profiles in share row exclusive mode;

-- [1] admin_action_logs — 이 센터 소속 전부(구조적으로 100% 테스트 로그, 위 설명 참고).
-- 반드시 reservations/memberships/profiles 삭제보다 먼저 실행(그 세 테이블을 참조하므로).
-- 삭제 직후 정말 0건이 됐는지 즉시 재확인 — 0이 아니면 이후 memberships 삭제로 절대
-- 진행하지 않고 즉시 중단(요청받은 안전장치, [L]의 락과 함께 이중으로 방어).
do $$
declare
  v_count int;
  v_after int;
begin
  select count(*) into v_count from admin_action_logs where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
  raise notice '[1] admin_action_logs(centerA 소속) 대상: %건', v_count;
  if v_count > 20000 then
    raise exception '[1] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;
  delete from admin_action_logs where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
  select count(*) into v_after from admin_action_logs where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
  raise notice '[1] 삭제 직후 재확인: %건 남음(0이어야 함)', v_after;
  if v_after <> 0 then
    raise exception '[1] admin_action_logs가 삭제 후에도 %건 남아 있습니다 — memberships 삭제를 진행하지 않고 중단합니다.', v_after;
  end if;
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
     and product_name = '통합테스트 수강권';
  raise notice '[3] "통합테스트 수강권" 대상: %건', v_count;
  -- (v4) 하한 guard 제거 — 이 모집단은 시점마다 여러 TEST_* profile_id 사이를 오간다는 것을
  -- 실측으로 확인했다(위 4)번). 0건이어도 안전하게 스킵되며(아래 delete들은 그냥 0행 처리),
  -- 상한만 "터무니없이 큰 값"을 잡는 용도로 유지한다.
  if v_count > 50000 then
    raise exception '[3] 예상보다 훨씬 많음(%건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_count;
  end if;

  if to_regclass('public.membership_transfers') is not null then
    delete from membership_transfers where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_id is null and product_name = '통합테스트 수강권'
    );
  end if;
  if to_regclass('public.product_passes') is not null then
    delete from product_passes where linked_membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_id is null and product_name = '통합테스트 수강권'
    );
  end if;
  if to_regclass('public.contracts') is not null then
    delete from contracts where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_id is null and product_name = '통합테스트 수강권'
    );
  end if;

  if to_regclass('public.point_transactions') is not null then
    delete from point_transactions where payment_id in (
      select id from payments where membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_id is null and product_name = '통합테스트 수강권'
      )
    );
  end if;
  delete from payments where membership_id in (
    select id from memberships
     where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
       and product_id is null and product_name = '통합테스트 수강권'
  );
  delete from reservations where membership_id in (
    select id from memberships
     where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
       and product_id is null and product_name = '통합테스트 수강권'
  );
  delete from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_id is null and product_name = '통합테스트 수강권';
end $$;

-- [4] product_name="통합테스트 수강권(P3)" — class-allowed-products-enforcement.test.ts 로컬 헬퍼
do $$
declare
  v_count int;
begin
  select count(*) into v_count from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_name = '통합테스트 수강권(P3)';
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
      );
    end if;
    if to_regclass('public.product_passes') is not null then
      delete from product_passes where linked_membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_name = '통합테스트 수강권(P3)'
      );
    end if;
    if to_regclass('public.contracts') is not null then
      delete from contracts where membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_name = '통합테스트 수강권(P3)'
      );
    end if;
    if to_regclass('public.point_transactions') is not null then
      delete from point_transactions where payment_id in (
        select id from payments where membership_id in (
          select id from memberships
           where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
             and product_name = '통합테스트 수강권(P3)'
        )
      );
    end if;
    delete from payments where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_name = '통합테스트 수강권(P3)'
    );
    delete from reservations where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_name = '통합테스트 수강권(P3)'
    );
    delete from memberships
     where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
       and product_name = '통합테스트 수강권(P3)';
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
     and product_name = 'P0-6 테스트 무제한권';
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
      );
    end if;
    if to_regclass('public.product_passes') is not null then
      delete from product_passes where linked_membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_name = 'P0-6 테스트 무제한권'
      );
    end if;
    if to_regclass('public.contracts') is not null then
      delete from contracts where membership_id in (
        select id from memberships
         where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
           and product_name = 'P0-6 테스트 무제한권'
      );
    end if;
    if to_regclass('public.point_transactions') is not null then
      delete from point_transactions where payment_id in (
        select id from payments where membership_id in (
          select id from memberships
           where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
             and product_name = 'P0-6 테스트 무제한권'
        )
      );
    end if;
    delete from payments where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_name = 'P0-6 테스트 무제한권'
    );
    delete from reservations where membership_id in (
      select id from memberships
       where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
         and product_name = 'P0-6 테스트 무제한권'
    );
    delete from memberships
     where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
       and product_name = 'P0-6 테스트 무제한권';
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
