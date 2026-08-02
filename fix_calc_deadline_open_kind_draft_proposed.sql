-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- 실브라우저 QA 재검증(섹션 5)에서 발견한 P1급 버그: calc_deadline()이 'open' kind를
-- 처리하지 않는다.
--
-- 조사 결과(중요):
--   center_settings에는 "예약 가능 기한(오픈 시점)" UI(app/manager/settings/page.tsx
--   "07. 예약 오픈 기한")가 저장하는 group_open_days_before/group_open_time,
--   private_open_days_before/private_open_time 컬럼이 이미 존재하고 정상 저장되지만,
--   calc_deadline(p_center_id, p_class_format, p_start_time, p_kind)의 실제 정의
--   (wire_settings.sql, PR #32에서 배선)는 p_kind를 'book' / 그 외(cancel) 두 갈래로만
--   분기한다 — 'open'이라는 kind 자체를 아예 모른다.
--
--   그런데 이번 QA 배치의 fix_class_booking_deadline_override_draft_proposed.sql에서
--   reserve_class()에 "예약 오픈 시점" 체크를 추가하며
--   calc_deadline(..., 'open')을 호출하도록 배선했다 — 이 호출은 calc_deadline() 내부에서
--   'book'이 아닌 모든 값을 무조건 "else(취소 설정)" 분기로 처리하기 때문에, 실제로는
--   group_cancel_days_before/group_cancel_time(취소 마감 설정, 보통 "1일 전")을 오픈 시점인
--   것처럼 잘못 사용하고 있었다 — "60일 전부터 예약 오픈" 같은 관리자 설정이 조용히
--   무시되고 대신 취소 마감 설정값이 쓰인 것.
--
--   이건 이전 배치 보고("C-2 예약 오픈 시점: P1-12에서 정상 배선됨")가 틀렸다는 뜻이다 —
--   그 결론은 calc_deadline()의 실제 정의를 다시 읽지 않고 "reserve_class가 calc_deadline을
--   'open' kind로 호출한다"는 사실만 보고 배선이 끝났다고 오판한 것이었다. 이번에
--   calc_deadline()의 실제 함수 본문을 직접 재확인해 잡아냈다.
--
-- 수정: calc_deadline()에 p_kind='open' 분기를 추가해
-- group_open_days_before/time · private_open_days_before/time을 읽도록 한다.
-- reserve_class()/cancel_reservation()은 이미 올바른 kind 문자열('book'/'open'/'cancel')로
-- 호출하고 있으므로 추가 수정이 필요 없다 — calc_deadline() 하나만 CREATE OR REPLACE.
--
-- 기존 데이터 영향: 없음(함수 재정의만). 예상 영향 행 수: 0.
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
        return null;   -- 설정 없음 → 폴백
    end if;

    -- 형태 + 종류에 맞는 (일수, 시각) 선택
    if p_class_format = 'private' then
        if p_kind = 'book' then
            v_days := v_settings.private_book_days_before;
            v_time := v_settings.private_book_time;
        elsif p_kind = 'open' then
            v_days := v_settings.private_open_days_before;
            v_time := v_settings.private_open_time;
        else
            v_days := v_settings.private_cancel_days_before;
            v_time := v_settings.private_cancel_time;
        end if;
    else
        if p_kind = 'book' then
            v_days := v_settings.group_book_days_before;
            v_time := v_settings.group_book_time;
        elsif p_kind = 'open' then
            v_days := v_settings.group_open_days_before;
            v_time := v_settings.group_open_time;
        else
            v_days := v_settings.group_cancel_days_before;
            v_time := v_settings.group_cancel_time;
        end if;
    end if;

    -- 수업일(한국시간) 기준 N일 전 날짜의 HH:MM (한국시간) 을 마감으로
    v_class_date := (p_start_time at time zone 'Asia/Seoul')::date;
    v_deadline_date := v_class_date - make_interval(days => v_days);

    -- 한국시간의 (날짜 + 시각) 을 timestamptz 로
    return ((v_deadline_date::text || ' ' || v_time::text) || '+09')::timestamptz;
end;
$$;

COMMIT;
