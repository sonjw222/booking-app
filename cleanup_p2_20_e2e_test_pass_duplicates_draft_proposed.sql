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
--   - 삭제 전 미리보기 COUNT + 상한(터무니없이 큰 값)만 가드 — 하한 없음(v4의 교훈: 시점마다
--     모집단이 달라질 수 있어 하한 가드는 오히려 정리를 막을 뿐).
--   - 삭제 직후 실제 삭제된 행 수(GET DIAGNOSTICS)가 미리보기 COUNT와 정확히 같은지 재확인,
--     다르면 그 자리에서 예외를 던져 전체 트랜잭션을 롤백.
--   - COMMIT 이후 최종 검증 SELECT로 남은 행(=FK로 제외된 5건 근처여야 함)을 직접 확인.
--
-- 대상 center_id: 3937eb89-3803-43e9-9a29-e893f779df1a (managerA 소유 전용 테스트 센터)
--
-- ⚠ 실행 전 반드시: 아래 [0] 미리보기 결과에서 center 이름이 실제로 테스트센터처럼 보이는지
-- 육안으로 확인한 뒤 진행하세요. [1]의 raise notice로 나오는 실제 대상 건수도 위 진단치
-- (891건 근처, 상한 3000 미만)와 크게 다르면 COMMIT 전에 멈추고 사용자에게 알리세요.
-- ============================================================

-- [0] 대상 센터 확인 — 반드시 먼저 실행해서 이름을 눈으로 확인
select id, name, status, created_at from centers where id = '3937eb89-3803-43e9-9a29-e893f779df1a';

BEGIN;

-- [L] 동시 쓰기 차단
lock table memberships in share row exclusive mode;
lock table reservations in share row exclusive mode;
lock table payments in share row exclusive mode;
lock table membership_transfers in share row exclusive mode;
lock table product_passes in share row exclusive mode;
lock table contracts in share row exclusive mode;
lock table admin_action_logs in share row exclusive mode;

-- [1] "E2E 테스트 수강권" 정리 — FK로 참조되는 membership은 NOT EXISTS로 전부 제외
do $$
declare
  v_target_ids uuid[];
  v_preview_count int;
  v_deleted int;
  v_remaining int;
begin
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

  v_preview_count := coalesce(array_length(v_target_ids, 1), 0);
  raise notice '[1] "E2E 테스트 수강권"(centerA, FK 참조 없는 것만) 삭제 대상: %건', v_preview_count;

  if v_preview_count > 3000 then
    raise exception '[1] 예상보다 훨씬 많음(%건, 진단 시점 891건) — 안전을 위해 중단합니다. 조건을 다시 확인하세요.', v_preview_count;
  end if;

  if v_preview_count = 0 then
    raise notice '[1] 삭제 대상이 0건입니다 — 스킵합니다(이미 정리되었거나 조건이 실제 데이터와 어긋남).';
  else
    delete from memberships where id = any(v_target_ids);
    get diagnostics v_deleted = row_count;
    raise notice '[1] 실제 삭제된 행 수: %건', v_deleted;
    if v_deleted <> v_preview_count then
      raise exception '[1] 삭제된 행 수(%건)가 미리보기 건수(%건)와 다릅니다 — 전체를 롤백합니다.', v_deleted, v_preview_count;
    end if;
  end if;

  select count(*) into v_remaining
    from memberships m
   where m.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
     and m.product_name = 'E2E 테스트 수강권';
  raise notice '[1] 삭제 후 centerA "E2E 테스트 수강권" 남은 행(=FK로 보존된 것, 대략 5건 근처 예상): %건', v_remaining;
end $$;

-- [2] 최종 검증 (COMMIT 전, 육안 확인용)
select
  m.id, m.profile_id, m.product_id, m.status, m.remaining_count, m.expires_at,
  exists (select 1 from reservations r where r.membership_id = m.id) as has_reservation
from memberships m
where m.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and m.product_name = 'E2E 테스트 수강권';

-- ⚠ 위 [1]의 notice와 [2]의 결과를 직접 눈으로 확인한 뒤에만 아래 COMMIT을 실행하세요.
-- 이상하면 COMMIT 대신 ROLLBACK을 실행하세요.
COMMIT;

-- [3] COMMIT 이후 최종 확인 (참고용, 트랜잭션 밖)
select count(*) as e2e_pass_remaining_centerA
  from memberships
 where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a' and product_name = 'E2E 테스트 수강권';

select count(*) as userA_total_memberships
  from memberships
 where profile_id = 'bf0939f6-d676-43bd-a164-c021ad623063';
