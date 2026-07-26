-- ============================================================
-- 테스트용 데이터 (Supabase SQL Editor에서 실행)
--
-- 실행 전:
--   1. schema.sql, reservation_functions.sql 실행 완료
--   2. 앱(/signup)에서 회원가입 완료 → accounts + 본인 profiles 행이 있어야 함
-- ============================================================

do $$
declare
    v_account   uuid;
    v_profile   uuid;
    v_figure    uuid;
    v_swim      uuid;
    -- 오늘(한국시간) 기준 날짜. 하드코딩하면 시간이 지나 '과거 수업'이 되어 예약이 막힘
    v_today     date := (now() at time zone 'Asia/Seoul')::date;
    v_d3        date;
    v_d5        date;
    v_d7        date;
begin
    -- 오늘 기준 미래 날짜 (예약 마감 규칙 때문에 과거/당일 수업은 예약 불가)
    v_d3 := v_today + 3;
    v_d5 := v_today + 5;
    v_d7 := v_today + 7;
    -- 가장 최근 가입한 계정을 "나"로 지정
    select id into v_account from accounts order by created_at desc limit 1;
    if v_account is null then
        raise exception '먼저 앱에서 회원가입을 해주세요 (accounts 테이블이 비어있어요)';
    end if;

    -- 내 대표 프로필
    select id into v_profile from profiles
    where account_id = v_account and is_primary = true limit 1;
    if v_profile is null then
        raise exception '대표 프로필이 없어요 (회원가입이 제대로 안 된 상태)';
    end if;

    -- 센터 2개
    -- status='approved' 필수: 승인된 센터만 회원에게 보이는 RLS 정책이 있음
    insert into centers (name, address, status)
    values ('어텐션 피겨팀', '서울 하남/교대 일대', 'approved')
        returning id into v_figure;
    insert into centers (name, address, status)
    values ('올림픽 스포츠수영', '서울 송파구 올림픽수영장', 'approved')
        returning id into v_swim;

    -- 수업: 오늘(KST) 기준 상대 날짜로 생성 → 언제 실행해도 '미래 수업'이 됨
    --   d3 = 3일 뒤, d5 = 5일 뒤, d7 = 7일 뒤
    --   (예약 마감시간 규칙 때문에 과거/당일 수업은 예약이 막힘)
    insert into classes (center_id, title, start_time, end_time, capacity) values
      (v_figure, '어텐션 스케이팅특강',  (v_d3::text || ' 07:10+09')::timestamptz, (v_d3::text || ' 09:00+09')::timestamptz, 12),
      (v_figure, '어텐션 원데이안무반',  (v_d3::text || ' 11:30+09')::timestamptz, (v_d3::text || ' 12:50+09')::timestamptz, 10),
      (v_figure, '어텐션 정규반 - 교대', (v_d3::text || ' 20:00+09')::timestamptz, (v_d3::text || ' 21:20+09')::timestamptz, 10),
      (v_figure, '어텐션 점프특강',      (v_d5::text || ' 19:00+09')::timestamptz, (v_d5::text || ' 20:20+09')::timestamptz, 8),
      (v_swim,   '성인 자유수영 레슨',   (v_d5::text || ' 10:00+09')::timestamptz, (v_d5::text || ' 11:00+09')::timestamptz, 6),
      -- 정원 1명: 대기(waitlist) 테스트용
      (v_swim,   '접영 마스터반',        (v_d7::text || ' 19:30+09')::timestamptz, (v_d7::text || ' 20:30+09')::timestamptz, 1);

    -- 센터 휴무일 (오늘 기준 상대 날짜)
    insert into center_holidays (center_id, holiday_date, reason) values
      (v_figure, (v_today + 10), '빙질 정비'),
      (v_figure, (v_today + 11), '빙질 정비'),
      (v_swim,   (v_today + 12), '정기 휴관');

    -- 내 대표 프로필에 수강권 부여
    insert into memberships (profile_id, center_id, product_name, total_count, remaining_count, expires_at)
    values (v_profile, v_figure, '피겨 정규 10회권', 10, 10, v_today + 90);
    insert into memberships (profile_id, center_id, product_name, total_count, remaining_count, expires_at)
    values (v_profile, v_swim, '수영 5회권', 5, 5, v_today + 60);

    raise notice '완료! 수업 날짜: % (3일뒤), % (5일뒤), % (7일뒤)',
        v_d3, v_d5, v_d7;
    raise notice '예약 캘린더(/reservation)에서 해당 날짜를 눌러 테스트하세요';
end $$;
