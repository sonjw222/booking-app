-- ============================================================
-- P2-20 goal2: "E2E 테스트 수강권" historical duplicate memberships 정리 (draft, 미실행)
--
-- 배경(진단으로 확인, 추측 아님 — CI run 31298648225/31298992075/31299144098/
-- 31299264654/31299381075, tests/integration/_diag_memberships.test.ts):
--   - TEST_USER_A(profile bf0939f6-d676-43bd-a164-c021ad623063)의 memberships 실제
--     COUNT(*)는 1557건(PostgREST 1000행 캡을 count:exact로 우회해 확인). 그중 951건이
--     centerA(3937eb89-3803-43e9-9a29-e893f779df1a) 소속.
--   - centerA 안에서 product_name='E2E 테스트 수강권'인 행은 profile_id 제한 없이
--     정확히 891건 — userA 827건 + 다른 한 profile_id(f2c9749a-b282-433b-8b60-a982b81a53f3,
--     v4 cleanup 조사에서 이미 이 세션의 다른 TEST_* 계정 기본 프로필로 확인된 것과 동일)
--     64건. distinct product_id는 {2f4e137b-2a18-4c64-be57-47eeba8f22a7, null} 두 값뿐이고
--     distinct center_id는 이 한 센터뿐 — product_id가 null인 111건이 섞여 있어 product_id
--     단독으로는 안전하게 식별할 수 없고, "정확한 product_name 문자열 + 정확한 center_id"가
--     구조적으로 안전한 식별 조건임을 확인했다. product_id=2f4e137b...는 실제
--     "E2E 테스트 수강권 상품"(product_kind=pass, centerA 소속) 행이며, 이 문자열은
--     tests/e2e/**의 createTestMembershipAdmin() 헬퍼(이미 get-or-create/self-healing으로
--     수정 완료 — 앞으로는 재누적되지 않음, 이번 정리는 수정 이전에 쌓인 과거분만 대상)만
--     쓴다(grep으로 재확인). created_at 범위는 2026-07-30~2026-08-08 — get-or-create
--     수정 배포 전 CI 반복 실행(특히 concurrency: cancel-in-progress: true로 취소된 실행이
--     afterAll 정리를 건너뛴 경우) 동안 누적된 것과 일치.
--
--   - .pass-pick-list가 회원 예약화면에서 뜨지 않는 실제 메커니즘(코드로 직접 확인):
--     lib/reservations.ts의 fetchUsableMembershipsByClass()는 usable_memberships_for_classes
--     RPC 응답을 .range()로 1000행씩 페이지네이션한다. 이 duplicate 891건 때문에 RPC가
--     "수업 1개당 ~744행"이라는 사실상 상수 크기의 결과를 매 class마다 반환하고, 클라이언트가
--     그 전부를 순차 왕복으로 받아온다 — 실측: n=1(수업 1개) 1페이지/744행/약 0.3~0.9초,
--     n=8 6페이지/5952행/약 1.6~1.9초, n=36(실제 실패 재현 조건) **27페이지/26784행/
--     약 12.4~13.9초**(page당 약 300~1100ms, 총 27회 순차 왕복). 실제 관측된 ".pass-pick-list가
--     10초 넘게 안 뜸" 증상과 이 27회 순차 왕복 12~14초가 정확히 일치한다 — 단일
--     미페이지네이션 RPC 호출 자체는 항상 0.3~0.9초로 빨랐지만(1000행 캡에 걸려 실제 총
--     행 수를 반영하지 못했을 뿐), 프로덕션 코드가 실제로 하는 페이지네이션 루프를 그대로
--     재현하자 문제가 명확히 재현됐다. 즉 "membership 수가 많으면 RPC가 느리다"가 아니라
--     "membership 수가 많으면 RPC 결과 자체가 커져서, 이를 다 받아오는 클라이언트 측
--     순차 페이지네이션 왕복 횟수가 늘어난다"가 정확한 인과관계다(RPC 서버 실행 자체는
--     항상 빠름 — 자세한 성능 특성은 별도 P6 항목으로 docs/TODO.md에 기록 예정, 이
--     스크립트가 RPC를 수정하지는 않음).
--
--   - reservations.membership_id를 참조하는 행이 실제로 5건 존재함(확인, 추측 아님):
--     2건은 status=attended(종료 상태), 3건은 status=waitlisted이고 class_start가
--     2026-08-16(진단 시점 기준 미래) — 아직 취소 가능한 살아있는 예약이다.
--     reservations.membership_id는 on delete 지정이 없고(NO ACTION),
--     fix_reservation_cancel_grace_period_draft_proposed.sql의 취소 유예시간 환불 로직이
--     이 컬럼으로 되돌려줄 membership을 찾는다 — 그래서 이 5건의 membership_id를 NULL로
--     비우거나 reservations 행 자체를 지우는 대신(v4 cleanup은 이렇게 했지만, 그 때는
--     아직 살아있는 미래 waitlist 예약이 없었다), **이 5건이 참조하는 membership은 이번
--     정리에서 아예 건드리지 않는다**(NOT EXISTS로 제외) — 살아있는 예약의 취소/환불
--     동작을 조금도 바꾸지 않기 위한 가장 보수적인 선택.
--   - payments.membership_id를 참조하는 행은 0건(확인).
--   - membership_transfers/product_passes/contracts는 service_role에 대한 SQL GRANT가
--     없어서(payments/admin_action_logs/accounts와 같은 계열의 이미 문서화된 별도 gap,
--     docs/TODO.md 참고 — 이 스크립트가 고치는 범위 아님) 진단 스크립트(PostgREST 경유)로는
--     사전에 실제 건수를 확인하지 못했다. 하지만 Supabase SQL Editor는 이 GRANT와 무관하게
--     동작하므로, 아래 [1]의 미리보기 SELECT가 실행 시점에 사용자가 직접 실제 값을 볼 수
--     있고, 무엇보다 아래 DELETE 자체가 이 세 테이블 전부를 NOT EXISTS로 제외 조건에 넣기
--     때문에 — 설령 참조 행이 있어도 그 membership만 조용히 스킵될 뿐 FK 위반이 나거나
--     이 세 테이블의 데이터를 이 스크립트가 건드리는 일은 없다(안전 근거는 실제 건수를
--     아는 것이 아니라 "NOT EXISTS로 구조적으로 절대 건드리지 않는다"는 조건 자체).
--   - admin_action_logs도 위와 동일한 GRANT gap으로 사전 건수 확인 불가 — 동일하게
--     membership_id/source_unassigned_id 양쪽 다 NOT EXISTS로 제외 조건에 포함한다.
--
-- FK 전수 재감사(2026-08-09, schema.sql 재확인 — v4 cleanup 당시 감사와 동일 결론):
--   memberships(id)를 references하는 테이블 = reservations, payments,
--   membership_transfers, product_passes(linked_membership_id), contracts,
--   admin_action_logs(membership_id, source_unassigned_id). locker_assignments/
--   point_transactions/progress_records는 profile_id만 참조하고 이번 정리는 profiles를
--   전혀 지우지 않으므로 대상 아님.
--
-- 안전장치:
--   - [L] 트랜잭션 시작 시 관련 테이블에 SHARE ROW EXCLUSIVE 락 — v4 cleanup에서 실증된
--     "검증 시점과 삭제 시점 사이 동시 쓰기" 문제를 구조적으로 차단.
--   - 정확한 product_name 문자열 + 정확한 center_id만 대상(부분 일치 없음, LIKE 없음).
--   - 6개 FK 테이블 전부를 NOT EXISTS로 제외 — 참조가 있는 membership은 절대 지우지 않음.
--   - 삭제 전 대상 COUNT + 상한(터무니없이 큰 값)만 가드 — 하한 없음(v4의 교훈: 시점마다
--     모집단이 달라질 수 있어 하한 가드는 오히려 정리를 막을 뿐).
--   - 삭제 직후 실제 삭제된 행 수(GET DIAGNOSTICS)가 대상 COUNT와 정확히 같은지, 그리고
--     삭제 후 남은 행 수가 "삭제 전 전체 - 삭제 대상"과 정확히 같은지, 마지막으로 남은 행
--     전부가 실제로 FK 참조를 갖고 있는지(=FK-free인데 안 지워진 행이 없는지) 3중으로
--     재확인 — 하나라도 안 맞으면 RAISE EXCEPTION으로 전체 트랜잭션을 롤백한다.
--
-- 대상 center_id: 3937eb89-3803-43e9-9a29-e893f779df1a (managerA 소유 전용 테스트 센터)
--
-- ⚠ [사고 기록, 2026-08-09] 이전 버전은 "[0] 미리보기 → BEGIN+LOCK+DELETE+[2] 검증
-- SELECT → (여기서 사용자가 육안 확인) → COMMIT"을 사용자가 Supabase SQL Editor에서
-- 서로 다른 두 번의 Run으로 나눠 실행하도록 안내했다. 실제로 이렇게 실행한 결과: [2]
-- 검증 SELECT는 트랜잭션 안에서 정확히 기대한 5건(전부 has_reservation=true)만 보여줬지만,
-- 그 뒤 별도 Run으로 COMMIT;을 실행하자 실제로는 아무것도 반영되지 않았다(재조회 결과
-- e2e_pass_remaining=891, 그대로). Supabase SQL Editor는 각 Run을 별도 커넥션/세션으로
-- 실행할 수 있어(커넥션 풀링), BEGIN을 실행한 세션과 COMMIT을 실행한 세션이 서로 다르면
-- BEGIN 세션의 트랜잭션은 커밋되지 못한 채 커넥션 반납 시 자동 ROLLBACK되고, COMMIT 세션은
-- "진행 중인 트랜잭션 없음" 상태라 사실상 아무 일도 하지 않는다 — DB는 그대로였다(사용자
-- 실측 확인). 그래서 이번 버전은 BEGIN부터 COMMIT까지 사람의 중간 개입 없이 **하나의 SQL
-- 스크립트, 하나의 Run**으로 끝나도록 구조를 바꿨다(아래 B 섹션). 사람이 보는 미리보기는
-- DB를 전혀 바꾸지 않는 A 섹션으로 완전히 분리했고, B 섹션 안의 안전성 검증은 전부 SQL
-- 자체(RAISE EXCEPTION → 자동 ROLLBACK)가 수행한다.
--
-- ⚠ 실행 순서: A(선택, 언제 실행해도 안전) 확인 → B 전체를 한 번에 복사해 Supabase
-- SQL Editor에 붙여넣고 **한 번만 Run** → C로 결과 확인.
-- ============================================================


-- ============================================================
-- A. READ-ONLY PREVIEW — DB를 전혀 수정하지 않음. B 실행 전 몇 번이든 따로 실행해도 안전.
-- ============================================================

-- A-0. 대상 센터 확인 — 이름이 실제로 테스트센터처럼 보이는지 육안 확인
select id, name, status, created_at from centers where id = '3937eb89-3803-43e9-9a29-e893f779df1a';

-- A-1. centerA "E2E 테스트 수강권" 전체 건수(profile_id 무관, 진단 시점 891건)
select count(*) as total_e2e_pass
  from memberships
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
   and product_name = 'E2E 테스트 수강권';

-- A-2. FK 참조가 전혀 없는(=B에서 실제로 삭제될) 건수
select count(*) as deletable_count
  from memberships m
 where m.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
   and m.product_name = 'E2E 테스트 수강권'
   and not exists (select 1 from reservations r where r.membership_id = m.id)
   and not exists (select 1 from payments p where p.membership_id = m.id)
   and not exists (select 1 from membership_transfers mt where mt.membership_id = m.id)
   and not exists (select 1 from product_passes pp where pp.linked_membership_id = m.id)
   and not exists (select 1 from contracts c where c.membership_id = m.id)
   and not exists (
     select 1 from admin_action_logs aal
      where aal.membership_id = m.id or aal.source_unassigned_id = m.id
   );

-- A-3. FK 참조가 있어(=B에서 보존될) 건수 — A-1 - A-2와 같아야 함
select count(*) as preserved_count
  from memberships m
 where m.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
   and m.product_name = 'E2E 테스트 수강권'
   and (
     exists (select 1 from reservations r where r.membership_id = m.id)
     or exists (select 1 from payments p where p.membership_id = m.id)
     or exists (select 1 from membership_transfers mt where mt.membership_id = m.id)
     or exists (select 1 from product_passes pp where pp.linked_membership_id = m.id)
     or exists (select 1 from contracts c where c.membership_id = m.id)
     or exists (
       select 1 from admin_action_logs aal
        where aal.membership_id = m.id or aal.source_unassigned_id = m.id
     )
   );

-- A-4. 보존될 membership 상세 — 어떤 FK 때문에 보존되는지까지 확인(진단 시점: 5건, 전부 has_reservation=true)
select
  m.id, m.profile_id, m.product_id, m.status, m.remaining_count, m.expires_at, m.created_at,
  exists (select 1 from reservations r where r.membership_id = m.id) as has_reservation,
  exists (select 1 from payments p where p.membership_id = m.id) as has_payment,
  exists (select 1 from membership_transfers mt where mt.membership_id = m.id) as has_transfer,
  exists (select 1 from product_passes pp where pp.linked_membership_id = m.id) as has_product_pass,
  exists (select 1 from contracts c where c.membership_id = m.id) as has_contract,
  exists (select 1 from admin_action_logs aal where aal.membership_id = m.id or aal.source_unassigned_id = m.id) as has_admin_log
from memberships m
where m.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and m.product_name = 'E2E 테스트 수강권'
  and (
    exists (select 1 from reservations r where r.membership_id = m.id)
    or exists (select 1 from payments p where p.membership_id = m.id)
    or exists (select 1 from membership_transfers mt where mt.membership_id = m.id)
    or exists (select 1 from product_passes pp where pp.linked_membership_id = m.id)
    or exists (select 1 from contracts c where c.membership_id = m.id)
    or exists (
      select 1 from admin_action_logs aal
       where aal.membership_id = m.id or aal.source_unassigned_id = m.id
    )
  );


-- ============================================================
-- B. ATOMIC CLEANUP — 아래 BEGIN부터 COMMIT까지 전체를 그대로 복사해서
--    Supabase SQL Editor에 붙여넣고 **한 번의 Run**으로 실행하세요.
--    이 안에서 대상 계산 → 안전 가드 → 삭제 → 3중 검증을 전부 수행하고,
--    하나라도 어긋나면 RAISE EXCEPTION으로 자동 ROLLBACK됩니다(사람이 중간에
--    COMMIT/ROLLBACK을 따로 실행할 필요 없음, 그런 구조를 만들지 않음).
-- ============================================================

BEGIN;

lock table memberships in share row exclusive mode;
lock table reservations in share row exclusive mode;
lock table payments in share row exclusive mode;
lock table membership_transfers in share row exclusive mode;
lock table product_passes in share row exclusive mode;
lock table contracts in share row exclusive mode;
lock table admin_action_logs in share row exclusive mode;

do $$
declare
  v_total_before int;
  v_target_ids uuid[];
  v_target_count int;
  v_expected_preserved int;
  v_deleted int;
  v_remaining_after int;
begin
  -- 락 확보 후(=동시 쓰기 차단된 상태에서) 다시 센 진짜 현재값. A 섹션의 값은 참고용일 뿐
  -- 이 값이 최종 판단 기준이다 — A를 본 시점과 B를 실행하는 시점 사이에 다른 세션이
  -- 값을 바꿨을 수 있기 때문(그래서 아래 판단은 전부 이 DO 블록 안에서 새로 계산한 값만 쓴다).
  select count(*) into v_total_before
    from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_name = 'E2E 테스트 수강권';
  raise notice '[B] 삭제 전 전체 건수: %건', v_total_before;

  select array_agg(m.id) into v_target_ids
    from memberships m
   where m.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and m.product_name = 'E2E 테스트 수강권'
     and not exists (select 1 from reservations r where r.membership_id = m.id)
     and not exists (select 1 from payments p where p.membership_id = m.id)
     and not exists (select 1 from membership_transfers mt where mt.membership_id = m.id)
     and not exists (select 1 from product_passes pp where pp.linked_membership_id = m.id)
     and not exists (select 1 from contracts c where c.membership_id = m.id)
     and not exists (
       select 1 from admin_action_logs aal
        where aal.membership_id = m.id or aal.source_unassigned_id = m.id
     );

  v_target_count := coalesce(array_length(v_target_ids, 1), 0);
  v_expected_preserved := v_total_before - v_target_count;
  raise notice '[B] 삭제 대상(FK 참조 없음): %건, 삭제 후 남아야 할 건수(FK 참조 있음): %건',
    v_target_count, v_expected_preserved;

  -- 가드 1: 상한(터무니없이 큰 값)만 방어 — 하한 없음(위 설명 참고)
  if v_target_count > 3000 then
    raise exception '[B] 예상보다 훨씬 많음(%건, 진단 시점 891건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_target_count;
  end if;

  if v_target_count = 0 then
    raise notice '[B] 삭제 대상이 0건입니다 — 스킵합니다(이미 정리되었거나 조건이 실제 데이터와 어긋남).';
  else
    delete from memberships where id = any(v_target_ids);
    get diagnostics v_deleted = row_count;
    raise notice '[B] 실제 삭제된 행 수: %건', v_deleted;

    -- 가드 2: 실제 삭제된 행 수가 계산한 대상 건수와 정확히 같아야 함
    if v_deleted <> v_target_count then
      raise exception '[B] 삭제된 행 수(%건)가 대상 건수(%건)와 다릅니다 — 롤백합니다.', v_deleted, v_target_count;
    end if;
  end if;

  select count(*) into v_remaining_after
    from memberships
   where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and product_name = 'E2E 테스트 수강권';
  raise notice '[B] 삭제 후 실제 남은 건수: %건 (기대값: %건)', v_remaining_after, v_expected_preserved;

  -- 가드 3: 삭제 후 남은 행 수가 "삭제 전 전체 - 삭제 대상"과 정확히 같아야 함
  if v_remaining_after <> v_expected_preserved then
    raise exception '[B] 삭제 후 남은 건수(%건)가 기대값(%건)과 다릅니다 — 롤백합니다.', v_remaining_after, v_expected_preserved;
  end if;

  -- 가드 4: 남은 행 전부가 실제로 FK 참조를 갖고 있어야 함(=FK-free인데 안 지워진 행이
  -- 하나라도 있으면 조건 불일치 — 롤백)
  if exists (
    select 1 from memberships m
     where m.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
       and m.product_name = 'E2E 테스트 수강권'
       and not exists (select 1 from reservations r where r.membership_id = m.id)
       and not exists (select 1 from payments p where p.membership_id = m.id)
       and not exists (select 1 from membership_transfers mt where mt.membership_id = m.id)
       and not exists (select 1 from product_passes pp where pp.linked_membership_id = m.id)
       and not exists (select 1 from contracts c where c.membership_id = m.id)
       and not exists (
         select 1 from admin_action_logs aal
          where aal.membership_id = m.id or aal.source_unassigned_id = m.id
       )
  ) then
    raise exception '[B] 삭제 후에도 FK 참조 없는 행이 남아 있습니다 — 조건 불일치, 롤백합니다.';
  end if;

  raise notice '[B] 4중 검증 전부 통과 — COMMIT 진행';
end $$;

COMMIT;


-- ============================================================
-- C. POST-COMMIT VERIFICATION — B가 COMMIT된 뒤 별도로 실행해서 확인
-- ============================================================
select count(*) as e2e_pass_remaining_centerA
  from memberships
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a' and product_name = 'E2E 테스트 수강권';

select count(*) as userA_total_memberships
  from memberships
 where profile_id = 'bf0939f6-d676-43bd-a164-c021ad623063';
