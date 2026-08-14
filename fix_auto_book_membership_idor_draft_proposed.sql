-- ============================================================
-- SEC-114-A/C(P0) — auto_book_membership() authorization bypass 최소 수정
--
-- [출처] 이 파일은 이 저장소의 다른 독립 세션(브랜치 security/sec114-auto-book-
-- authorization, 커밋 d111930)이 먼저 작성한 fix_auto_book_membership_authorization_
-- draft_proposed.sql의 authorization 설계를 그대로 채택한 버전이다(2026-08-13
-- 최종 교차검증에서 두 세션이 독립적으로 같은 취약점을 발견했음을 확인, 사용자가
-- has_permission(center_id,'schedule.own.group.booking') 방식을 최종안으로 선택).
-- 이번 세션이 먼저 작성했던 my_managed_center_ids() 기반 버전 + 정책 회귀 동시 수정
-- (schedule_rules/휴무일/마감/일일한도/프라이빗 동시진행)은 폐기하고, 정책 회귀는
-- SEC-114-B로 분리해 별도 후속 배치로 남긴다(아래 [범위 밖] 참고). business logic은
-- fix_auto_book_oneperday.sql(Live와 일치 확인된 최신 정의) 그대로 — authorization
-- 블록 하나만 추가한다.
--
-- [배경] auto_book_membership(p_membership_id uuid)이 SECURITY DEFINER(owner=postgres)로
-- PUBLIC EXECUTE 상태였고, 함수 내부에 caller authorization 체크가 전혀 없었다.
-- anon/authenticated 누구나 타인의 membership_id UUID만 알면 직접 호출해 memberships
-- RLS를 완전히 우회(security definer)하고 피해자 profile_id로 reservations를 생성하며
-- remaining_count를 소진시킬 수 있었다(2026-08-12/13 anon-key 실증 확인 완료).
--
-- [정상 호출 경로 — 저장소 전수 검색, 이 둘 외 다른 호출자 없음]
--   A) lib/classes.ts retryAutoBook() → app/manager/classes/page.tsx "미배치 수강권 재시도"
--   B) fulfill_order() 내부 perform auto_book_membership(...)
--   두 경로 모두 caller가 "그 membership이 속한 센터를 관리하는 매니저(또는 platform
--   admin)"이므로, 함수 내부에 정확히 그 조건을 검사한다.
--
-- [권한 키 선정 근거] 기존 permission catalog에서 이 기능(그룹수업 회원 예약 생성/변경)에
-- 대응하는 기존 키 'schedule.own.group.booking'을 재사용한다(delete_class_safe가
-- 'schedule.own.group.delete'를 센터 전체 클래스 삭제 게이트로 재사용하는 것과 동일한
-- 기존 관례). has_permission()은 owner 역할이면 permission_key와 무관하게 항상 true를
-- 반환하므로(add_personal_permissions.sql:56 `when m.is_owner then true`), 오너 매니저는
-- 이 특정 키가 role_permissions에 없어도 항상 통과한다 — retryAutoBook()을 실제로 쓰는
-- 오너/일반 매니저 흐름에 영향 없음. is_platform_admin()은 has_permission()과 별개로
-- 항상 허용.
--
-- [범위 밖 — SEC-114-B, 별도 후속 배치] membership_schedule_rules, calc_deadline(open/book),
-- center_holidays, daily_book_limit, private_max_concurrent, capacity 행잠금, waitlist
-- 정책, membership.status='active', reservation_type/source/created_by_account_id 명시
-- 설정. 이번 파일은 이 중 무엇도 건드리지 않는다 — 기존 business logic(하루 1개 제한,
-- class_allowed_products 체크, 요일 매칭, 정원 카운트, expires_at 필터)도 단 한 줄도
-- 안 바꿨다.
--
-- ⚠ 종속 위험(이번 수정 범위 밖): has_permission()은 manager_centers가 무결하다는 전제로
-- 동작한다. SEC-101/SEC-112(manager_centers self-join/self-promote)가 아직 패치되지
-- 않았다면, 부정하게 manager_centers 행을 만든 계정도 이 authorization을 통과할 수
-- 있다 — 그래서 적용 순서상 SEC-101/112 배치를 먼저 적용하는 것을 권장한다(최종
-- 보고서 "권장 SQL 적용 순서" 참고).
--
-- 변경 요약: (1) membership 조회 직후 authorization 블록 추가 (2) SET search_path=public
-- (3) REVOKE EXECUTE FROM PUBLIC/anon, GRANT TO authenticated.
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
    -- 있는 매니저이거나 platform admin이어야만 통과.
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

        -- 하루 1개 제한: 이미 그 날짜에 예약 잡았으면 건너뜀
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

COMMIT;

-- ============================================================
-- 완료. 적용 후 아래로 확인:
--   1) select has_function_privilege('anon', 'auto_book_membership(uuid)', 'EXECUTE');       -- false 기대
--   2) select has_function_privilege('authenticated', 'auto_book_membership(uuid)', 'EXECUTE'); -- true 기대
--   3) 타 센터 매니저/무권한 스태프 계정으로 다른 센터 membership 호출 → 거부 확인
--   4) 정상 매니저 계정("미배치 수강권 재시도") 실제 클릭 → 정상 동작 확인
--   5) 실제 주문 1건을 auto_book=true로 fulfill → 회귀 없는지 확인
-- ============================================================
