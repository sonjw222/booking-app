-- ============================================================
-- P1-14: attendance-policy.test.ts가 남긴 memberB(TEST_USER_B) waitlisted 테스트 예약/수업
-- 정리 (draft, 미실행)
--
-- 배경(진단으로 확인, 추측 아님 — CI run 31362464170,
-- tests/integration/_diag_p1_14_waitlist_pollution.test.ts, 실행 후 파일 삭제):
--   - attendance-policy.test.ts 3연속 Integration 실패("이번 주 대기예약 가능 횟수(10회)를
--     초과했어요")의 직접 원인은 memberB(TEST_USER_B, profile f2c9749a-b282-433b-8b60-
--     a982b81a53f3)의 waitlisted reservations가 centerA(3937eb89-3803-43e9-9a29-
--     e893f779df1a, managerA 소유 전용 테스트센터)에 13건 누적된 것 — 한도(10)를 이미
--     넘어서, 이 테스트가 새로 만들려는 waitlisted 예약이 첫 시도부터 거부됨.
--   - 13건 전부 정확히 같은 class title = 'P3 출결-대기거부'(attendance-policy.test.ts의
--     "정원이 찬 그룹 수업에서 대기(waitlisted)로 등록된 예약은 attended로 바꿀 수 없다"
--     테스트가 만드는, 이 파일에만 있는 리터럴 문자열, LIKE 아님 — 정확히 일치), 정확히
--     같은 profile_id(memberB), 정확히 같은 center_id(centerA). created_at은
--     2026-08-07T16:26 ~ 2026-08-09T22:07(UTC) 사이에 걸쳐 여러 건 분산 — 단발성 사고가
--     아니라 이 테스트를 실행할 때마다 거의 매번 1건씩 새로 쌓인 것과 일치.
--   - root cause(코드로 확인, 추측 아님): reservation_functions.sql의 "매니저 취소예약 정리"
--     DELETE 정책(reservations, status in ('cancelled','no_show')만 허용)과, 이 테스트가
--     의도적으로 waitlisted 상태로 남기는 예약(그게 이 테스트의 검증 대상 자체 — "대기
--     중인 예약은 attended로 못 바꾼다"는 가드를 확인하고 취소는 하지 않음) 사이의 범위
--     불일치. attendance-policy.test.ts의 구 afterAll은 매니저 세션(RLS 적용) 기반
--     cleanupTestClass()로 지웠는데, 이 정책이 waitlisted 상태를 허용하지 않아 DELETE가
--     에러 없이 조용히 0건 삭제로 끝났다(Postgrest의 RLS 매칭 실패 시 동작 — 예외 아님).
--     같은 원인이 private-class-capacity.test.ts에서 이미 한 번 발견/우회된 적이 있음
--     (그 파일 자체 주석 참고) — 이번에 attendance-policy.test.ts에도 동일하게 적용해
--     재발을 막았다(admin/service_role 기반 cleanupTestClassAdmin()으로 전환 + beforeAll
--     self-healing 정리 추가, 코드 변경은 이 SQL과 별도 커밋). 이 SQL은 그 코드 수정
--     이전에 이미 쌓인 과거분만 대상으로 한다.
--
-- FK 전수 재감사(2026-08-10, schema.sql + 전체 migration grep으로 확인):
--   reservations(id)를 references하는 테이블 = admin_action_logs.reservation_id
--   (not null, on delete 지정 없음 = NO ACTION)뿐. attendance-policy.test.ts는 이 13건을
--   전부 reserve_class()(회원 셀프 예약 RPC)로만 만들었고 admin_assign_reservation 계열을
--   전혀 쓰지 않아 admin_action_logs가 이 reservation_id를 참조할 이유가 구조적으로 없지만,
--   아래 [A-2]/[B]에서 실제로 NOT EXISTS로 재확인하고 참조가 있으면 그 행은 보존한다.
--   classes(id)를 references하는 테이블 = class_trainers/class_allowed_products/
--   schedule_memos(전부 on delete cascade, 안전), reservations(no cascade, 이미 위에서
--   먼저 지움), admin_action_logs.class_id(not null, no cascade — 이것도 NOT EXISTS로
--   재확인).
--
-- 안전장치:
--   - profile_id(memberB 정확한 UUID) + center_id(centerA 정확한 UUID) + class title
--     정확히 일치("P3 출결-대기거부", LIKE 없음) + status='waitlisted' — 4개 조건이 모두
--     동시에 맞아야 대상. 실제 사용자가 이 문자열 그대로인 수업 제목을 가질 수 없음
--     (attendance-policy.test.ts에만 존재하는 테스트 전용 리터럴).
--   - reservations → classes 순서로 삭제(FK 방향과 일치, delete_class_safe()의 기존 순서와
--     동일한 패턴).
--   - admin_action_logs가 reservation_id 또는 class_id로 참조하는 행은 NOT EXISTS로 완전히
--     제외 — 참조가 있으면 그 예약/수업은 이번 정리에서 건드리지 않는다.
--   - [L] 트랜잭션 시작 시 관련 테이블에 SHARE ROW EXCLUSIVE 락.
--   - 삭제 전 대상 재계산(락 확보 후, A 섹션 값은 참고용) + 상한 sanity guard(50 — 진단
--     시점 13건 기준으로 넉넉히, 그러나 "훨씬 많음"을 걸러낼 수 있는 값).
--   - 삭제 직후 실제 삭제된 행 수(GET DIAGNOSTICS)가 대상 건수와 정확히 같은지 검증.
--   - 삭제 후 같은 조건으로 재조회했을 때 남은 건수가 0(또는 FK로 보존된 건수)과 정확히
--     같은지 검증.
--   - 하나라도 어긋나면 RAISE EXCEPTION으로 전체 트랜잭션을 롤백한다.
--
-- 대상 profile_id(memberB): f2c9749a-b282-433b-8b60-a982b81a53f3
-- 대상 center_id(centerA):  3937eb89-3803-43e9-9a29-e893f779df1a
-- 대상 class title:         P3 출결-대기거부 (정확히 일치)
--
-- ⚠ 참고: 이 테스트는 class 1개당 memberA의 confirmed 예약과 memberB의 waitlisted 예약을
-- 함께 만든다(정원 1명을 memberA가 먼저 채우고 memberB가 대기로 밀림). 이 SQL은 memberB의
-- waitlisted 예약만 지우고, memberA의 confirmed 예약이 여전히 남아있는 class는 "다른 살아
-- 있는 예약이 있음"으로 판단해 안전하게 보존한다(B 섹션의 class 삭제 로직 참고) — 즉 이
-- 13개 class 자체는 십중팔구 이번 정리 후에도 남는다(정상, 의도된 동작). 이 잔여 class/
-- memberA의 confirmed 예약은 오늘 실패하는 주간 대기예약 한도 버그와는 무관하고(그 버그는
-- status='waitlisted' 건수만 센다), classes 테이블 누적이라는 별개의 이미 알려진 이슈
-- (docs/TODO.md RES-002/TEST-004 계열)의 연장선이라 이 정리의 범위 밖으로 남겨둔다.
--
-- ⚠ 실행 순서: A(선택, 언제 실행해도 안전) 확인 → B 전체를 한 번에 복사해 Supabase
-- SQL Editor에 붙여넣고 **한 번만 Run**(BEGIN부터 COMMIT까지 사람 개입 없이 한 번에 —
-- 이전 사고 기록: BEGIN/COMMIT을 서로 다른 Run으로 나누면 커넥션 풀링 때문에 커밋이 실제로
-- 반영되지 않을 수 있음, cleanup_p2_20 파일 헤더 참고) → C로 결과 확인.
-- ============================================================


-- ============================================================
-- A. READ-ONLY PREVIEW — DB를 전혀 수정하지 않음. B 실행 전 몇 번이든 따로 실행해도 안전.
-- ============================================================

-- A-0. 대상 계정/센터가 실제로 테스트 전용인지 육안 확인
select id, name, status from centers where id = '3937eb89-3803-43e9-9a29-e893f779df1a';
select id, name from profiles where id = 'f2c9749a-b282-433b-8b60-a982b81a53f3';

-- A-1. 정확한 조건에 맞는 waitlisted 예약 전체 건수(진단 시점 13건)
select count(*) as total_target
  from reservations r
  join classes c on c.id = r.class_id
 where r.status = 'waitlisted'
   and r.profile_id = 'f2c9749a-b282-433b-8b60-a982b81a53f3'
   and c.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
   and c.title = 'P3 출결-대기거부';

-- A-2. FK 참조가 전혀 없는(=B에서 실제로 삭제될) 건수
select count(*) as deletable_count
  from reservations r
  join classes c on c.id = r.class_id
 where r.status = 'waitlisted'
   and r.profile_id = 'f2c9749a-b282-433b-8b60-a982b81a53f3'
   and c.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
   and c.title = 'P3 출결-대기거부'
   and not exists (select 1 from admin_action_logs aal where aal.reservation_id = r.id)
   and not exists (select 1 from admin_action_logs aal2 where aal2.class_id = c.id);

-- A-3. FK 참조가 있어(=B에서 보존될) 건수와 상세 — A-1 - A-2와 같아야 함, 진단 시점 0건 예상
select
  r.id as reservation_id, r.class_id, r.status, r.created_at,
  exists (select 1 from admin_action_logs aal where aal.reservation_id = r.id) as has_admin_log_by_reservation,
  exists (select 1 from admin_action_logs aal2 where aal2.class_id = r.class_id) as has_admin_log_by_class
  from reservations r
  join classes c on c.id = r.class_id
 where r.status = 'waitlisted'
   and r.profile_id = 'f2c9749a-b282-433b-8b60-a982b81a53f3'
   and c.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
   and c.title = 'P3 출결-대기거부'
   and (
     exists (select 1 from admin_action_logs aal where aal.reservation_id = r.id)
     or exists (select 1 from admin_action_logs aal2 where aal2.class_id = r.class_id)
   );

-- A-4. 함께 삭제될 classes(=위 reservations가 속한, 다른 살아있는 예약이 없는 수업) 미리보기
select c.id, c.title, c.start_time, c.center_id, c.created_at
  from classes c
 where c.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
   and c.title = 'P3 출결-대기거부'
   and exists (
     select 1 from reservations r
      where r.class_id = c.id and r.status = 'waitlisted'
        and r.profile_id = 'f2c9749a-b282-433b-8b60-a982b81a53f3'
   );


-- ============================================================
-- B. ATOMIC CLEANUP — 아래 BEGIN부터 COMMIT까지 전체를 그대로 복사해서
--    Supabase SQL Editor에 붙여넣고 **한 번의 Run**으로 실행하세요.
-- ============================================================

BEGIN;

lock table reservations in share row exclusive mode;
lock table classes in share row exclusive mode;
lock table admin_action_logs in share row exclusive mode;

do $$
declare
  v_target_res_ids   uuid[];
  v_target_class_ids uuid[];
  v_target_count     int;
  v_deleted_res      int;
  v_deleted_cls      int;
  v_remaining_after  int;
begin
  -- 락 확보 후(=동시 쓰기 차단된 상태에서) 다시 계산한 진짜 현재값만 최종 판단 기준으로 쓴다.
  select array_agg(r.id) into v_target_res_ids
    from reservations r
    join classes c on c.id = r.class_id
   where r.status = 'waitlisted'
     and r.profile_id = 'f2c9749a-b282-433b-8b60-a982b81a53f3'
     and c.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and c.title = 'P3 출결-대기거부'
     and not exists (select 1 from admin_action_logs aal where aal.reservation_id = r.id)
     and not exists (select 1 from admin_action_logs aal2 where aal2.class_id = c.id);

  v_target_count := coalesce(array_length(v_target_res_ids, 1), 0);
  raise notice '[B] 삭제 대상 waitlisted 예약: %건', v_target_count;

  -- 가드 1: 상한(진단 시점 13건 기준으로 넉넉히, 그러나 이상 급증은 걸러냄)
  if v_target_count > 50 then
    raise exception '[B] 예상보다 훨씬 많음(%건, 진단 시점 13건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_target_count;
  end if;

  if v_target_count = 0 then
    raise notice '[B] 삭제 대상이 0건입니다 — 스킵합니다(이미 정리되었거나 조건이 실제 데이터와 어긋남).';
  else
    -- 이 예약들이 속한 class 중, 삭제 대상이 아닌 다른 살아있는 예약이 없는 class만
    -- 함께 정리 대상으로 계산(다른 예약이 남아있으면 그 class는 건드리지 않음).
    select array_agg(distinct c.id) into v_target_class_ids
      from classes c
     where c.id in (select r.class_id from reservations r where r.id = any(v_target_res_ids))
       and not exists (
         select 1 from reservations r2
          where r2.class_id = c.id and not (r2.id = any(v_target_res_ids))
       )
       and not exists (select 1 from admin_action_logs aal2 where aal2.class_id = c.id);

    delete from reservations where id = any(v_target_res_ids);
    get diagnostics v_deleted_res = row_count;
    raise notice '[B] 실제 삭제된 reservations: %건', v_deleted_res;

    if v_deleted_res <> v_target_count then
      raise exception '[B] 삭제된 reservations 수(%건)가 대상 건수(%건)와 다릅니다 — 롤백합니다.', v_deleted_res, v_target_count;
    end if;

    if v_target_class_ids is not null and array_length(v_target_class_ids, 1) > 0 then
      delete from classes where id = any(v_target_class_ids);
      get diagnostics v_deleted_cls = row_count;
      raise notice '[B] 실제 삭제된 classes: %건 (id: %)', v_deleted_cls, v_target_class_ids;
    else
      v_deleted_cls := 0;
      raise notice '[B] 함께 삭제할 classes 없음(다른 살아있는 예약이 남아있거나 admin_action_logs 참조가 있음)';
    end if;
  end if;

  -- 가드 2: 삭제 후 같은 조건으로 재조회하면 0건이어야 함(FK로 보존되는 행은 애초에 조건에서
  -- 제외했으므로, 이 조건에 남는 행이 있으면 안 됨)
  select count(*) into v_remaining_after
    from reservations r
    join classes c on c.id = r.class_id
   where r.status = 'waitlisted'
     and r.profile_id = 'f2c9749a-b282-433b-8b60-a982b81a53f3'
     and c.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and c.title = 'P3 출결-대기거부'
     and not exists (select 1 from admin_action_logs aal where aal.reservation_id = r.id)
     and not exists (select 1 from admin_action_logs aal2 where aal2.class_id = c.id);

  if v_remaining_after <> 0 then
    raise exception '[B] 삭제 후에도 조건에 맞는 행이 %건 남아 있습니다 — 롤백합니다.', v_remaining_after;
  end if;

  raise notice '[B] 검증 전부 통과 — COMMIT 진행';
end $$;

COMMIT;


-- ============================================================
-- C. POST-COMMIT VERIFICATION — B가 COMMIT된 뒤 별도로 실행해서 확인
-- ============================================================

-- C-1. memberB의 centerA waitlisted 예약 총 건수(RPC가 세는 것과 동일한 범위) — 0건이어야 함
select count(*) as memberB_centerA_waitlisted_remaining
  from reservations r
  join classes c on c.id = r.class_id
 where r.status = 'waitlisted'
   and r.profile_id = 'f2c9749a-b282-433b-8b60-a982b81a53f3'
   and c.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';

-- C-2. "P3 출결-대기거부" class 잔존 건수(전부 삭제됐거나, 다른 살아있는 예약 때문에 보존된
-- 것만 남아야 함)
select id, title, start_time from classes
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a' and title = 'P3 출결-대기거부';
