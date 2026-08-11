-- ============================================================
-- ROLLBACK for fix_auto_book_membership_authorization_draft_proposed.sql
-- DO NOT RUN unless you need to revert SEC-114's authorization fix.
--
-- 이 파일은 auto_book_membership()을 이번 수정 이전 Live 상태(fix_auto_book_oneperday.sql
-- 기준 — 하루 1개 제한 + class_allowed_products 체크 포함, authorization 없음,
-- search_path 미설정, PUBLIC EXECUTE)로 정확히 되돌린다. business logic은 fix 파일과
-- 완전히 동일 — authorization 블록과 search_path 설정만 제거한다.
--
-- ⚠️ 롤백하면 SEC-114-A/C(누구나 타인의 membership_id로 예약 생성/잔여횟수 소진 가능)가
-- 다시 열립니다. 정말 필요한 경우에만 실행하세요.
-- ============================================================

BEGIN;

create or replace function auto_book_membership(p_membership_id uuid)
returns json
language plpgsql
security definer
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

    select auto_book_days into v_days from products where id = v_mem.product_id;
    if v_days is null or array_length(v_days, 1) is null then
        return json_build_object('booked', 0, 'reason', 'not_weekday_pass');
    end if;

    v_left := coalesce(v_mem.remaining_count, 0);
    if v_left <= 0 then
        return json_build_object('booked', 0, 'reason', 'no_remaining');
    end if;

    for v_class in
        select c.id, c.capacity, c.start_time,
               (c.start_time at time zone 'Asia/Seoul')::date as class_date
        from classes c
        where c.center_id = v_mem.center_id
          and c.status = 'open'
          and c.start_time > now()
          and (v_mem.expires_at is null or c.start_time::date <= v_mem.expires_at)
          and extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int = any(v_days)
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

-- 원래 상태(PUBLIC EXECUTE)로 복원
grant execute on function auto_book_membership(uuid) to public;

COMMIT;
