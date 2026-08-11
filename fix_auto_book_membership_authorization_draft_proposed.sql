-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- SEC-114-A/C: auto_book_membership() SECURITY DEFINER authorization bypass — P0 최소 수정
--
-- 배경(2026-08-12 READ-ONLY 보안 감사, SEC-114):
--   auto_book_membership(p_membership_id uuid)이 SECURITY DEFINER(owner=postgres)로
--   PUBLIC EXECUTE 상태였고, 함수 내부에 my_account_id()/auth.uid()/has_permission() 등
--   caller authorization 체크가 전혀 없었다. 같은 패밀리의 reserve_class/reserve_with_
--   membership/cancel_reservation/refund_membership(전부 my_account_id() 소유권 체크)와
--   fulfill_order/manager_set_attendance/admin_assign_reservation/admin_cancel_reservation
--   (전부 my_managed_center_ids()/is_permission 기반 매니저 체크)와 비교해 이 함수 하나만
--   무방비였다. anon/authenticated 누구나 타인의 membership_id UUID만 알면
--   supabase.rpc('auto_book_membership', {p_membership_id: '<피해자 UUID>'})로 직접 호출해
--   memberships RLS를 완전히 우회(security definer)하고 피해자 profile_id로 reservations를
--   생성하며 remaining_count를 소진시킬 수 있었다(단 1회 호출로 전량 소진 가능).
--
-- 정상 호출 경로(저장소 전수 검색, 이번 것 외 다른 호출자 없음):
--   A) lib/classes.ts retryAutoBook() → app/manager/classes/page.tsx "미배치 수강권 재시도"
--      (매니저가 unplaced_weekday_passes()로 자기 센터 목록만 본 뒤 재시도 클릭)
--   B) fulfill_order() 내부에서 perform auto_book_membership(...)(주문 발급 시 auto_book
--      옵션이 켜져 있으면 호출, 실패해도 exception when others then null로 무시)
--   두 경로 모두 "그 membership이 속한 센터를 관리할 권한이 있는 매니저(또는 platform admin)"
--   가 전제이므로, 함수 내부에 정확히 그 조건을 검사하도록 추가한다.
--
-- 사용 permission key 선정 근거:
--   기존 permission catalog(schema.sql) 전수 검색 결과, 이 기능(그룹수업에 회원 예약을
--   생성/변경)에 정확히 대응하는 기존 키는 'schedule.own.group.booking'
--   ("그룹 수업의 회원 예약, 출결 상태를 변경할 수 있습니다")이다. has_permission()의
--   실제 구현(reservation_functions.sql)을 확인한 결과 'own'/'other' 구분은 카탈로그
--   라벨링일 뿐 has_permission() 자체는 role_permissions/account_center_permissions만
--   조회하고 "그 스태프가 실제로 담당하는 수업인지"는 검사하지 않는다 — 즉 이 프로젝트의
--   기존 관례(delete_class_safe가 "수업그룹 삭제" 용도인 'schedule.own.group.delete'를
--   센터 전체 클래스 삭제 게이트로 재사용하는 것과 동일한 패턴)에 따라
--   'schedule.own.group.booking'을 "이 센터에서 그룹수업 예약을 다룰 수 있는 스태프인가"
--   판정에 그대로 재사용한다. 새 permission key는 만들지 않았다.
--   플랫폼 운영자는 has_permission()과 별개로 is_platform_admin()으로 항상 허용
--   (proposed_rls_gap_batch_d.sql:112에 이미 있는 'has_permission(...) or is_platform_admin()'
--   패턴과 동일).
--
-- ⚠️ 종속 위험(이번 수정 범위 밖): has_permission()은 manager_centers 테이블이 무결하다는
--   전제로 동작한다. SEC-101(임의 센터 self-join)/SEC-112(staff self-promote)가 아직
--   패치되지 않은 상태라면, 부정하게 manager_centers 행을 만든 계정도 이 authorization을
--   통과할 수 있다 — 이 문제는 SEC-101/112가 별도로 막아야 하며 이 파일은 그 두 이슈를
--   전혀 건드리지 않는다(별도 SQL, 별도 rollback 유지).
--
-- 이번 수정에 포함하지 않은 것(SEC-114-B, 범위 밖 — 별도 TODO로 분리, docs/TODO.md 참고):
--   center.status='approved', booking deadline/open deadline, allow_same_day_booking,
--   daily_book_limit(센터설정), center_holidays, private_max_concurrent, capacity 행잠금,
--   waitlist 정책, membership_schedule_rules(+P1-17 override), membership.status='active',
--   reservation_type/source/created_by_account_id 명시적 설정.
--   기존 business logic(하루 1개 제한, class_allowed_products 체크, 요일 매칭, 정원 카운트,
--   expires_at 필터)은 단 한 줄도 바꾸지 않았다 — 아래 함수 본문은 fix_auto_book_oneperday.sql
--   (현재 Live와 일치 확인된 최신 정의)에 authorization 블록 하나만 삽입한 것이다.
--
-- 변경 요약:
--   1) 함수 본문 맨 앞(membership 조회 직후)에 caller authorization 블록 추가
--   2) SET search_path = public 추가(이 함수만 — 예약 RPC 패밀리 전체 하드닝은 별도 P2/P3)
--   3) REVOKE EXECUTE FROM PUBLIC, REVOKE FROM anon, GRANT TO authenticated
--   4) fulfill_order() 내부 호출은 fulfill_order 자체가 SECURITY DEFINER(owner=postgres)로
--      실행되므로, 이 REVOKE와 무관하게 owner 권한으로 계속 정상 동작한다(PostgreSQL은
--      객체 소유자에게 자기 소유 객체에 대한 암묵적 전권을 부여 — GRANT/REVOKE ACL과
--      무관). 두 함수의 owner가 동일(postgres)한지는 적용 전 아래 진단 SQL로 재확인 권장.
-- ============================================================

BEGIN;

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
    v_used_dates date[] := '{}';       -- 이미 예약 잡은 날짜들
    v_cdate   date;
begin
    select * into v_mem from memberships where id = p_membership_id for update;
    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;

    -- [SEC-114-A/C 신규] caller authorization — membership 조회 직후, 다른 어떤 로직보다
    -- 먼저 검사한다. 이 membership이 속한 센터를 관리할 권한(그룹수업 예약 처리 권한)이
    -- 있는 매니저이거나 platform admin이어야만 통과. 이 체크가 없으면 누구나(anon 포함)
    -- 타인의 membership_id만 알면 예약을 만들고 잔여횟수를 소진시킬 수 있었다(SEC-114).
    if not (
        has_permission(v_mem.center_id, 'schedule.own.group.booking')
        or is_platform_admin()
    ) then
        raise exception '이 수강권으로 자동예약을 실행할 권한이 없어요';
    end if;

    -- 이 수강권이 요일반인지 확인
    select auto_book_days into v_days from products where id = v_mem.product_id;
    if v_days is null or array_length(v_days, 1) is null then
        return json_build_object('booked', 0, 'reason', 'not_weekday_pass');
    end if;

    -- 남은 횟수 (무제한이면 자동예약 안 함)
    v_left := coalesce(v_mem.remaining_count, 0);
    if v_left <= 0 then
        return json_build_object('booked', 0, 'reason', 'no_remaining');
    end if;

    -- 대상 수업: 같은 센터 + 지정 요일 + 오늘 이후 + 만료 전, 빠른 순
    for v_class in
        select c.id, c.capacity, c.start_time,
               (c.start_time at time zone 'Asia/Seoul')::date as class_date
        from classes c
        where c.center_id = v_mem.center_id
          and c.status = 'open'
          and c.start_time > now()
          and (v_mem.expires_at is null or c.start_time::date <= v_mem.expires_at)
          and extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int = any(v_days)
          -- 이 수강권으로 들을 수 있는 수업만 (예약조건이 지정돼 있으면 그것만)
          and (
                not exists (select 1 from class_allowed_products cap where cap.class_id = c.id)
                or exists (
                    select 1 from class_allowed_products cap
                    where cap.class_id = c.id and cap.product_id = v_mem.product_id
                )
              )
        order by c.start_time asc
    loop
        exit when v_left <= 0;

        v_cdate := v_class.class_date;

        -- ★ 하루 1개 제한: 이미 그 날짜에 예약 잡았으면 건너뜀
        if v_cdate = any(v_used_dates) then
            continue;
        end if;

        -- 그 날짜에 이미 다른 예약이 있어도 건너뜀 (기존 예약 포함)
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

        -- 정원 확인
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

-- PUBLIC/anon 직접 실행 차단, authenticated만 허용(내부 로직이 매니저/운영자 권한을
-- 별도로 다시 검사하므로 authenticated 전체에 EXECUTE를 줘도 안전).
revoke execute on function auto_book_membership(uuid) from public;
revoke execute on function auto_book_membership(uuid) from anon;
grant execute on function auto_book_membership(uuid) to authenticated;
-- service_role: 실제 런타임/테스트 경로 어디도 이 RPC를 service_role로 직접 호출하지
-- 않음(app/lib 전체에 service_role 사용 자체가 없음, 신규 회귀 테스트도 authenticated/anon
-- 클라이언트로만 호출) — 불필요한 GRANT를 추가하지 않는다.

COMMIT;

-- ============================================================
-- 완료. 적용 후 아래로 확인:
--   1) select has_function_privilege('anon', 'auto_book_membership(uuid)', 'EXECUTE');       -- false 기대
--   2) select has_function_privilege('authenticated', 'auto_book_membership(uuid)', 'EXECUTE'); -- true 기대
--   3) 타 센터 매니저/무권한 스태프 계정으로 다른 센터 membership 호출 → 거부 확인
--   4) 정상 매니저 계정("미배치 수강권 재시도") 실제 클릭 → 정상 동작 확인
--   5) 실제 주문 1건을 auto_book=true로 fulfill → 회귀 없는지 확인
-- ============================================================
