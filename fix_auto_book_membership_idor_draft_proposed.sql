-- ============================================================
-- SEC-114(P0): auto_book_membership() IDOR — 임의 회원 수강권으로 자동예약/차감
--
-- [확인된 사실 — 코드 감사 + 실증]
--   fix_auto_book_oneperday.sql의 auto_book_membership(p_membership_id uuid)는
--   caller가 누구인지 전혀 검사하지 않고, 조회한 membership 행의 profile_id를
--   그대로 예약자로 쓰고 그 membership의 remaining_count를 그대로 차감했다.
--   Live EXECUTE grant는 PUBLIC(→ anon 포함)이었고, anon-key로 존재하지 않는
--   UUID를 넣어 호출했을 때 42501(권한 거부)이 아니라 함수 내부의 커스텀 P0001
--   예외("수강권을 찾을 수 없어요")가 그대로 돌아와 anon이 실제로 함수 본문을
--   실행할 수 있음을 실증 확인했다(행 생성/차감은 전혀 일으키지 않는 안전한
--   프로브 — 존재하지 않는 UUID라 첫 select에서 즉시 NOT FOUND로 끝남).
--
--   → 임의의(짐작 가능하든 아니든, "UUID를 안다"고 가정) 타인의 membership_id를
--     넣으면: 그 사람 명의로 예약 생성 + 그 사람 수강권 잔여횟수 차감이 완결된다.
--     로그인조차 필요 없다.
--
-- [정상 호출 경로 — 반드시 보존, 코드로 확인]
--   1) fulfill_order()(add_auto_booking.sql/add_direct_payment.sql/
--      add_unplaced_passes.sql/reservation_functions.sql 버전들)가 주문 처리
--      직후 방금 발급한(그 주문의 profile_id 소유) membership_id로 내부 호출.
--      fulfill_order() 자체는 매니저/오너 전용(v_order.center_id in
--      my_managed_center_ids() or is_platform_admin()) — 이 내부 호출은 caller가
--      "매니저"인 상태에서 일어난다(주문한 회원 본인이 아님).
--      ⚠ 단, add_refund_and_membership.sql의 fulfill_order 재정의에는 이
--      auto_book_membership 호출이 빠져 있다 — 어느 버전이 실제 Live에 적용돼
--      있는지 git만으로는 확정할 수 없다(migration ledger 갭, SEC-119 진단 SQL로
--      적용 전 재확인 권장). 이 파일은 이 불확실성과 무관하게 안전하다 — 아래
--      권한 검사는 "membership.center_id를 관리하는 사람"만 통과시키므로, 매니저가
--      자기 센터 주문을 처리하며 내부 호출하는 한 정상 동작한다.
--   2) lib/classes.ts retryAutoBook() — 관리자 "미배치 수강권" 화면에서, 그
--      센터 관리자가 목록에 뜬 회원의 membership_id로 재시도 버튼을 누르는
--      경로. 여기도 회원 본인이 아니라 그 센터 관리자가 호출자다.
--   → 앱 전체에서 회원이 자기 자신을 위해 이 RPC를 직접 호출하는 경로는 없다
--     (member self-service 아님). 즉 올바른 권한 모델은 "membership 소유자
--     본인" 검사가 아니라 manager_set_attendance/fulfill_order와 동일한
--     "그 membership.center_id를 관리하는 사람(또는 플랫폼 운영자)" 검사다.
--     소유자 본인 검사를 넣으면 위 두 정상 경로가 전부 깨진다(내부 호출 시점의
--     my_account_id()는 항상 "그 주문/그 화면을 처리하는 매니저"이지 membership
--     주인이 아니다) — 이 실수를 하지 않도록 의도적으로 소유자 검사 대신
--     매니저 권한 검사를 선택했다.
--
--   [2026-08-13 통합 정리에서 재확인] 이 함수의 authorization으로
--   has_permission(center_id, '특정 permission key')처럼 세분화된 검사도 검토했으나,
--   fulfill_order()/manager_set_attendance() 등 이 함수의 실제 정상 호출 맥락이 이미
--   전부 my_managed_center_ids()(세분권한 없이 "그 센터 매니저면 누구나") 모델을 쓰고
--   있어, 이 함수만 더 엄격한 검사를 쓰면 "fulfill_order는 통과시키는 매니저인데
--   auto_book_membership 직접 호출은 막히는" 일관성 없는 보안 경계가 생긴다. 세분
--   권한이 필요하다는 제품 판단이 서면 fulfill_order/manager_set_attendance까지
--   포함한 별도 배치(SEC-116)로 한 번에 통일하는 것을 권장 — 이 함수 하나만 먼저
--   좁히지 않는다.
--
--   SECURITY DEFINER 함수 안에서 다른 SECURITY DEFINER 함수를 직접 호출하면
--   그 안에서도 함수 소유자 권한으로 실행되므로, EXECUTE를 authenticated로
--   좁혀도(아래 [3]) fulfill_order()의 내부 호출 자체는 영향받지 않는다
--   (owner는 자기 함수에 대한 EXECUTE를 암묵적으로 항상 갖는다). retryAutoBook()은
--   로그인한 관리자가 PostgREST를 통해 직접 호출하므로 authenticated grant로
--   충분하다 — anon/PUBLIC은 필요 없다.
--
-- [이번에 같이 닫는 정책 회귀 — reserve_class/usable_memberships와 대조해 확인]
--   기존 auto_book_membership은 아래를 전혀 검사하지 않았다(reserve_class는 전부
--   검사함 — 이 파일이 그 기준선):
--     - pass_selection_mode('all'/'selected') + class_allowed_products(P1-17
--       override 포함한 membership_schedule_rules)
--     - 예약 오픈/마감 시각(calc_deadline, 수업별 booking_deadline_min override)
--     - 센터 휴무일(center_holidays)
--     - 일일 예약 가능 횟수(center_settings.daily_book_limit)
--     - 프라이빗 수업 동시 진행 제한(center_settings.private_max_concurrent)
--   이미 정상 동작하던 것(이번에 안 건드림): 폐강/마감 수업 제외, 이미 시작한
--   수업 이후 제외, 같은 날짜 중복 예약 방지, 정원 초과 시 건너뛰기.
--   (참고: 이 함수는 정원 초과 시 대기(waitlisted)를 만들지 않고 그냥 건너뛴다
--   — 기존 동작 그대로 유지. 요일반 자동예약은 "확정 가능한 자리만" 채우는
--   설계로 판단, 이번 배치에서 새로 대기예약을 만들도록 바꾸지 않는다.)
--
--   [2026-08-13 통합 정리에서 수정] 최초 작성 시 class_allowed_products 필터를
--   "그 class_id에 class_allowed_products 행이 하나라도 있는지"로 판정했다 — 이건
--   `classes.pass_selection_mode` 컬럼이 도입되기 전(2026-08-11 이전)의 구식 패턴과
--   동일하다. 현재 데이터 불변식(mode='all'이면 class_allowed_products는 항상
--   비어있고, mode='selected'면 항상 정확한 집합으로 채워짐, add_class_trainers_
--   pass_selection_mode_draft_proposed.sql이 기존 474건을 이 불변식대로 마이그레이션함
--   확인됨)상 결과는 우연히 동일하지만, 코드가 실제 정책 컬럼(`c.pass_selection_mode`)을
--   참조하지 않고 파생 상태(행 존재 여부)로 추론하는 것은 최신 reserve_class/
--   reserve_with_membership과 100% 동일한 판정식이 아니다. 이 파일은 이제
--   `c.pass_selection_mode = 'all' / 'selected'`를 reserve_class와 정확히 동일한
--   두 절(cap 존재 여부 + P1-17 override) 형태로 직접 참조하도록 고쳤다 — "오래된
--   함수 본문을 기준으로 덮어쓰지 말 것"이라는 지시에 따라 최신 Live reserve_class
--   본문(add_class_trainers_pass_selection_mode_draft_proposed.sql)에서 그대로
--   가져온 조건식이다.
--
-- [영향받는 기존 데이터] 없음 — 함수 재정의 + GRANT/REVOKE만, 테이블/데이터 변경 없음.
-- [예상 행 수] 0 (DDL만).
-- [위험도] 낮음 — 정상 호출 경로(매니저 주문 처리 내부 호출, 관리자 미배치
--   수강권 재시도 화면)는 권한 검사를 통과하므로 그대로 동작. 새로 추가된 정책
--   검사들은 reserve_class에 이미 있는 것과 동일한 조건을 그대로 재사용했다.
--
-- ⚠ 종속 위험(이번 수정 범위 밖): has_permission()/my_managed_center_ids() 둘 다
--   manager_centers 테이블이 무결하다는 전제로 동작한다. SEC-101/112/113
--   (manager_centers self-join/self-promote/orphan-then-reclaim)이 아직 패치되지
--   않았다면, 그 취약점으로 부정 취득한 manager_centers 행도 이 authorization을
--   통과할 수 있다 — 적용 순서상 SEC-101/112/113 배치를 먼저 적용하는 것을 권장한다
--   (최종 보고서 "적용 순서" 참고).
--
-- 여러 번 실행해도 안전(create or replace + drop/grant는 멱등).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] 함수 재정의
-- ------------------------------------------------------------
create or replace function auto_book_membership(p_membership_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_mem     record;
    v_days    int[];
    v_left    int;
    v_booked  int := 0;
    v_class   record;
    v_taken   int;
    v_used_dates date[] := '{}';
    v_cdate   date;
    v_book_deadline timestamptz;
    v_open_deadline timestamptz;
    v_daily_enabled boolean;
    v_daily_limit   int;
    v_daily_count   int;
    v_pmc_enabled boolean;
    v_pmc_limit   int;
    v_concurrent  int;
begin
    select * into v_mem from memberships where id = p_membership_id for update;
    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;

    -- [SEC-114] 이 함수는 회원 self-service가 아니라 그 센터 관리자(또는 플랫폼
    -- 운영자) 전용 기능이다 — 정상 호출 경로 둘 다(fulfill_order 내부 호출,
    -- retryAutoBook 관리자 화면) 호출 시점의 caller가 그 센터 매니저다.
    if not (v_mem.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 수강권을 자동예약 처리할 권한이 없어요';
    end if;

    select auto_book_days into v_days from products where id = v_mem.product_id;
    if v_days is null or array_length(v_days, 1) is null then
        return json_build_object('booked', 0, 'reason', 'not_weekday_pass');
    end if;

    v_left := coalesce(v_mem.remaining_count, 0);
    if v_left <= 0 then
        return json_build_object('booked', 0, 'reason', 'no_remaining');
    end if;

    select daily_book_limit_enabled, daily_book_limit,
           private_max_concurrent_enabled, private_max_concurrent
      into v_daily_enabled, v_daily_limit, v_pmc_enabled, v_pmc_limit
    from center_settings where center_id = v_mem.center_id;

    for v_class in
        select c.id, c.capacity, c.start_time, c.end_time, c.class_format,
               c.booking_deadline_min, c.center_id, c.title, c.pass_selection_mode,
               (c.start_time at time zone 'Asia/Seoul')::date as class_date,
               (c.start_time at time zone 'Asia/Seoul')::time as class_time,
               extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int as class_dow
        from classes c
        where c.center_id = v_mem.center_id
          and c.status = 'open'
          and c.start_time > now()
          and (v_mem.expires_at is null or c.start_time::date <= v_mem.expires_at)
          and extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int = any(v_days)
          -- [pass_selection_mode — reserve_class와 정확히 동일한 두 절]
          and (
                c.pass_selection_mode = 'all'
                or v_mem.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = c.id)
              )
          and (
                (
                    c.pass_selection_mode = 'selected'
                    and exists (
                        select 1 from class_allowed_products cap
                        where cap.class_id = c.id and cap.product_id = v_mem.product_id
                    )
                )
                or v_mem.product_id is null
                or not exists (select 1 from membership_schedule_rules r where r.product_id = v_mem.product_id)
                or exists (
                    select 1 from membership_schedule_rules r
                    where r.product_id = v_mem.product_id
                      and (r.day_of_week is null or r.day_of_week = extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int)
                      and (r.start_time is null or r.start_time = (c.start_time at time zone 'Asia/Seoul')::time)
                      and (r.class_title is null or c.title like '%' || r.class_title || '%')
                )
              )
          -- [정책 회귀 수정] 센터 휴무일
          and not exists (
                select 1 from center_holidays ch
                where ch.center_id = c.center_id
                  and ch.holiday_date = (c.start_time at time zone 'Asia/Seoul')::date
              )
        order by c.start_time asc
    loop
        exit when v_left <= 0;
        v_cdate := v_class.class_date;
        if v_cdate = any(v_used_dates) then
            continue;
        end if;
        if exists (
            select 1 from reservations r
            join classes c2 on c2.id = r.class_id
            where r.profile_id = v_mem.profile_id
              and r.status in ('confirmed', 'waitlisted', 'attended')
              and (c2.start_time at time zone 'Asia/Seoul')::date = v_cdate
        ) then
            v_used_dates := array_append(v_used_dates, v_cdate);
            continue;
        end if;

        -- [정책 회귀 수정] 예약 마감/오픈 시각 — reserve_class와 동일 계산.
        if v_class.booking_deadline_min is not null then
            v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
        else
            v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
            if v_book_deadline is null then
                v_book_deadline := v_class.start_time;
            end if;
        end if;
        if now() > v_book_deadline then
            continue;
        end if;

        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            continue;
        end if;

        -- [정책 회귀 수정] 프라이빗 수업 동시 진행 제한 — reserve_class와 동일 조건.
        if v_class.class_format = 'private' and coalesce(v_pmc_enabled, false) and v_pmc_limit is not null then
            select count(*) into v_concurrent
            from classes c2
            join reservations r2 on r2.class_id = c2.id and r2.status = 'confirmed'
            where c2.center_id = v_mem.center_id
              and c2.class_format = 'private'
              and c2.id <> v_class.id
              and c2.status <> 'cancelled'
              and c2.start_time < v_class.end_time
              and c2.end_time > v_class.start_time;

            if v_concurrent >= v_pmc_limit then
                continue;
            end if;
        end if;

        -- [정책 회귀 수정] 일일 예약 가능 횟수 — reserve_class와 동일 조건(그 날짜
        -- 기존 예약 수 기준, 이번 호출에서 이미 넣은 것도 reservations에 반영돼 있어
        -- 다음 반복에서 자연히 카운트된다).
        if coalesce(v_daily_enabled, false) and v_daily_limit is not null then
            select count(*) into v_daily_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = v_mem.profile_id
              and c.center_id = v_mem.center_id
              and (c.start_time at time zone 'Asia/Seoul')::date = v_cdate
              and r.status in ('confirmed', 'waitlisted');

            if v_daily_count >= v_daily_limit then
                v_used_dates := array_append(v_used_dates, v_cdate);
                continue;
            end if;
        end if;

        select count(*) into v_taken
        from reservations
        where class_id = v_class.id and status in ('confirmed', 'attended');
        if v_taken >= v_class.capacity then
            continue;
        end if;

        insert into reservations (class_id, profile_id, membership_id, status)
        values (v_class.id, v_mem.profile_id, v_mem.id, 'confirmed');
        v_used_dates := array_append(v_used_dates, v_cdate);
        v_left := v_left - 1;
        v_booked := v_booked + 1;
    end loop;

    if v_booked > 0 then
        update memberships
           set remaining_count = remaining_count - v_booked
         where id = p_membership_id
           and remaining_count is not null;
    end if;

    return json_build_object('booked', v_booked);
end;
$$;

-- ------------------------------------------------------------
-- [2] EXECUTE 최소화 — PUBLIC/anon 완전 차단, authenticated만 허용
--     (내부 권한 검사와 별개의 방어선 — 둘 다 통과해야 실행됨)
-- ------------------------------------------------------------
revoke all on function auto_book_membership(uuid) from public;
revoke all on function auto_book_membership(uuid) from anon;
grant execute on function auto_book_membership(uuid) to authenticated;

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select pg_get_functiondef('auto_book_membership(uuid)'::regprocedure);
select routine_name, security_type
from information_schema.routines
where routine_name = 'auto_book_membership';
select grantee, privilege_type
from information_schema.routine_privileges
where routine_name = 'auto_book_membership';
