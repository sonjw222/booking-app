-- ============================================================
-- fix_auto_book_membership_idor_draft_proposed.sql 롤백
--
-- SEC-114 수정 이전(fix_auto_book_oneperday.sql 기준) 상태로 auto_book_membership()과
-- 그 EXECUTE 권한을 되돌린다.
-- ⚠ 이 롤백은 SEC-114 IDOR(임의 membership_id로 익명/타인 자동예약·차감)와
-- 정책 회귀(pass_selection_mode/schedule rule/휴무일/예약마감/일일한도/프라이빗
-- 동시진행 미검사)를 전부 그대로 복원한다 — 회귀 테스트가 실제로 이 수정 때문에
-- 실패하는 것으로 확인된 경우에만, 그리고 그 실패의 근본 원인을 먼저 규명한
-- 뒤에만 사용할 것.
--
-- 여러 번 실행해도 안전.
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
    v_used_dates date[] := '{}';
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

grant execute on function auto_book_membership(uuid) to public;

COMMIT;

-- ============================================================
-- 완료. fix_auto_book_oneperday.sql 정의 + PUBLIC EXECUTE로 정확히 복원됨.
-- ============================================================
