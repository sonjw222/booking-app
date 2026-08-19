-- ============================================================
-- P2-22 — 공유 테스트센터(getOrCreateOwnedTestCenter로 재사용되는 managerA 소유 센터)에
-- 쌓인 leftover 미래 시각 class fixture 정리 (draft, 미실행)
--
-- [배경 — 코드/실측 감사로 확인, 추측 아님]
-- getOrCreateOwnedTestCenter()는 항상 같은 센터 하나(id: 3937eb89-3803-43e9-9a29-e893f779df1a,
-- managerA 소유)를 재사용한다. 이 함수는 자기 자신의 self-healing sweep(TEST-004 #45)으로
-- start_time이 1시간 이상 "과거"인 class는 자동 정리하지만, start_time이 아직 "미래"인
-- class는 건드리지 않는다. 여러 테스트 파일이 큰 hoursFromNow 오프셋(며칠~몇 달 뒤)으로
-- class를 만들고 실행 중 죽으면(CI cancel-in-progress 등) 그 class는 영구히 미래 시각
-- 그대로 남는다.
--
-- 2026-08-13 SEC-114 회귀 테스트(auto-book-membership-security.test.ts, AUTO-SEC-I) 조사
-- 중 이 센터에서 status='open' + start_time > now()인 class가 300개 이상 쌓여있음을
-- read-only로 실측 확인했다(제목 예: "P3 통합-*", "CLASS-001 기본값사용",
-- "SETTINGS-REAUDIT *", "E2E 한도재충전 *", "P1-12 *", "P2 알림격리-*",
-- "DIAG-NEWCLASS-BUG *" 등 — 여러 테스트 파일/여러 세션의 잔재, 계속 늘어나는 목록이라
-- 제목 리터럴을 전부 나열하는 방식은 유지보수가 안 됨). auto_book_membership()은
-- "센터+요일+미배정(class_allowed_products 없음)"만 맞으면 이런 leftover까지 자동예약
-- 대상으로 잡아, 방금 만든 테스트 class뿐 아니라 leftover까지 같이 예약돼 "정확히 N개만
-- 예약돼야 한다" 류의 assert가 간헐적으로 실패한다(docs/TODO.md P2-22 참고). E2E 쪽
-- daily-book-limit/버튼 텍스트 매칭류 플레이키니스에도 같은 계열로 기여하는 것으로 보임.
--
-- [정확한 대상 판정 기준 — 제목 리터럴 나열 대신 구조적 기준을 쓴다]
-- 1) center_id가 정확히 이 하나의 공유 테스트센터일 것(다른 센터는 절대 건드리지 않음).
-- 2) status = 'open' and start_time > now()  ← 실제로 auto_book_membership()의 매칭
--    대상이 되는, 문제를 일으키는 바로 그 집합.
-- 3) created_at < now() - interval '1 hour'  ← 지금 막 어떤 세션이 돌리고 있는 테스트가
--    방금 만든 class까지 실수로 지우지 않기 위한 안전장치. 정상적인 테스트 실행은
--    class 생성부터 정리(또는 사용)까지 전부 몇 분 안에 끝나므로, 생성된 지 1시간이
--    넘었는데 아직 안 지워졌다면 100% leftover다(TEST-004 #45의 sweep과 동일한 안전
--    마진 값을 그대로 재사용).
-- 이 기준은 제목 문자열에 의존하지 않아 앞으로 새로 생기는 테스트 fixture 이름에도
-- 자동으로 대응한다 — 반대로 "실제 운영 중인 미래 수업"일 가능성은 이 center_id 자체가
-- 자동화 테스트 전용으로만 쓰이는 센터라 구조적으로 0이다(실제 회원 대상 서비스에
-- 노출된 적 없음).
--
-- [실행 순서 — 반드시 순서대로]
--   A(선택, read-only, 몇 번이든 안전) → B(atomic, 반드시 BEGIN~COMMIT 한 번에 Run) → C(검증)
-- ============================================================

-- ============================================================
-- A. READ-ONLY PREVIEW — DB를 전혀 수정하지 않음. B 실행 전 몇 번이든 따로 실행해도 안전.
-- ============================================================

-- A-1. 정리 대상 class 총 건수 + 가장 오래/최근 생성된 것의 시각(육안으로 규모 확인)
select count(*) as target_class_count,
       min(created_at) as oldest_created_at,
       max(created_at) as newest_created_at,
       min(start_time) as earliest_start_time,
       max(start_time) as latest_start_time
from classes
where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and status = 'open'
  and start_time > now()
  and created_at < now() - interval '1 hour';

-- A-2. 제목별 건수(어떤 테스트들이 leftover를 남겼는지 참고용)
select title, count(*) as row_count
from classes
where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and status = 'open'
  and start_time > now()
  and created_at < now() - interval '1 hour'
group by title
order by row_count desc;

-- A-3. 이 정리 대상 class들에 딸린 reservations 총 건수(같이 지워질 행 수 참고용)
select count(*) as target_reservation_count
from reservations r
join classes c on c.id = r.class_id
where c.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and c.status = 'open'
  and c.start_time > now()
  and c.created_at < now() - interval '1 hour';

-- ============================================================
-- B. 실제 정리(원자적) — 반드시 A로 먼저 규모를 확인한 뒤, BEGIN부터 COMMIT까지
-- 한 번에(전체 선택) Run 하세요. 안전장치: 대상이 3000건을 넘으면(육안 확인한 규모의
-- 10배 이상 — 조건식 버그로 엉뚱한 것까지 잡혔을 가능성) 스스로 중단합니다.
-- ============================================================

BEGIN;

do $$
declare
    v_count int;
begin
    select count(*) into v_count
    from classes
    where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
      and status = 'open'
      and start_time > now()
      and created_at < now() - interval '1 hour';

    if v_count > 3000 then
        raise exception 'P2-22 정리 대상이 예상 범위(최대 3000건)를 초과했습니다(%건) — 조건식을 다시 확인하세요. 안전을 위해 중단합니다.', v_count;
    end if;
end $$;

delete from reservations r
using classes c
where r.class_id = c.id
  and c.center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and c.status = 'open'
  and c.start_time > now()
  and c.created_at < now() - interval '1 hour';

delete from classes
where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and status = 'open'
  and start_time > now()
  and created_at < now() - interval '1 hour';

COMMIT;

-- ============================================================
-- C. 검증(read-only) — B 실행 직후 실행. 아래 두 쿼리 모두 0이 나와야 정상.
-- ============================================================

-- C-1. 정리 대상 조건에 걸리는 class가 더 이상 없는지 확인
select count(*) as remaining_target_classes
from classes
where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a'
  and status = 'open'
  and start_time > now()
  and created_at < now() - interval '1 hour';

-- C-2. 참고: 이 센터에 실제로 남은 class 총 건수(정리 대상이 아니었던 것 포함 —
-- 방금 다른 세션이 만들었거나 과거 시각인 것 등은 정상적으로 남아있어야 함)
select count(*) as total_remaining_classes_in_shared_center
from classes
where center_id = '3937eb89-3803-43e9-9a29-e893f779df1a';
