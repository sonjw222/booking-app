-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_calc_deadline_open_kind_draft_proposed.sql was applied ⚠️
-- 롤백 — calc_deadline()을 'open' kind 분기 추가 이전(PR #32 wire_settings.sql 버전, 'book'
-- 아니면 전부 취소 설정으로 처리하던 상태)으로 되돌린다.
--
-- ⚠️ 주의: fix_class_booking_deadline_override_draft_proposed.sql이 이미 적용돼 있다면
-- reserve_class()가 여전히 calc_deadline(...,'open')을 호출한다 — 이 롤백 이후에는 다시
-- "오픈 시점" 체크가 조용히 취소 설정값을 대신 쓰는 이전의 잘못된 상태로 돌아간다(새로운
-- 버그가 생기는 게 아니라 이 파일 적용 전의 버그 상태로 되돌아가는 것).
-- ============================================================

BEGIN;

create or replace function calc_deadline(
    p_center_id uuid,
    p_class_format text,
    p_start_time timestamptz,
    p_kind text
)
returns timestamptz
language plpgsql stable
as $$
declare
    v_settings record;
    v_days int;
    v_time time;
    v_class_date date;
    v_deadline_date date;
begin
    select * into v_settings from center_settings where center_id = p_center_id;
    if not found then
        return null;
    end if;

    if p_class_format = 'private' then
        if p_kind = 'book' then
            v_days := v_settings.private_book_days_before;
            v_time := v_settings.private_book_time;
        else
            v_days := v_settings.private_cancel_days_before;
            v_time := v_settings.private_cancel_time;
        end if;
    else
        if p_kind = 'book' then
            v_days := v_settings.group_book_days_before;
            v_time := v_settings.group_book_time;
        else
            v_days := v_settings.group_cancel_days_before;
            v_time := v_settings.group_cancel_time;
        end if;
    end if;

    v_class_date := (p_start_time at time zone 'Asia/Seoul')::date;
    v_deadline_date := v_class_date - make_interval(days => v_days);

    return ((v_deadline_date::text || ' ' || v_time::text) || '+09')::timestamptz;
end;
$$;

COMMIT;
