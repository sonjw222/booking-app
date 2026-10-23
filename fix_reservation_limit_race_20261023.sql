-- F06·F12 동시 요청 경쟁 차단 (2026-10-23) — 후속 SQL, 운영 직접 적용 금지(Codex 검토·적용 대상)
--
-- 발견(격리 재현, tests/rls-real/reservationRace.rls.test.ts): 일일 예약 제한·프라이빗 동시 제한은 "현재 건수를 센 뒤 insert" 방식이라, 서로 다른 트랜잭션이 동시에 들어오면
--   둘 다 "아직 한도 미만"을 보고 통과해 한도를 넘는다.
--   · 프라이빗 동시 제한 1건: 서로 다른 계정이 같은 시간대 서로 다른 프라이빗 수업을 동시에 예약하면 2건이 확정됨(8회 중 5회 관찰).
--   · 일일 제한 1회: 같은 프로필이 서로 다른 수강권으로 같은 날 서로 다른 수업을 동시에 예약하면 2건이 확정될 수 있음(같은 수강권이면 수강권 행 잠금이 직렬화해 막힘).
-- 수정: 한도를 세기 직전에 트랜잭션 단위 advisory lock 을 잡아 같은 한도 범위의 요청을 직렬화한다(잠금은 트랜잭션 종료 시 자동 해제).
--   · 일일 제한: 키 = (프로필, KST 날짜)  — 다른 프로필·다른 날짜 요청은 서로 기다리지 않는다
--   · 프라이빗 동시 제한: 키 = 센터 — 제한이 켜져 있고 숫자가 있을 때만 잠근다
--   한도 판정 식·메시지·예약 로직은 그대로다. 잠금 순서는 항상 (일일 → 프라이빗 → 수강권 행 잠금)이고 다른 함수는 이 advisory 키를 쓰지 않아 교착 위험이 없다.
-- 적용 방식: reserve_class / reserve_with_membership 의 운영 정의를 pg_get_functiondef 로 읽어 정확히 한 군데씩 치환(0건/2건 이상이면 중단). 마커로 재실행 무시.
-- 호환: 앱 코드 변경 없음. 한도가 꺼져 있으면 잠금도 없다(성능 영향 없음). 같은 한도 범위의 동시 요청만 순서대로 처리돼 약간 기다릴 수 있다.

do $patch$
declare
    v_sig  text;
    v_def  text;
    v_var  text;
    v_n    integer;
begin
    foreach v_sig in array array['public.reserve_class(uuid,uuid)', 'public.reserve_with_membership(uuid,uuid,uuid)'] loop
        v_def := pg_get_functiondef(v_sig::regprocedure);
        if v_def like '%-- limit-race-lock%' then continue; end if;

        select count(*) into v_n from regexp_matches(v_def, 'if\s+coalesce\(v_daily_enabled,\s*false\)\s+and\s+v_daily_limit\s+is\s+not\s+null\s+then', 'gi');
        if v_n <> 1 then raise exception '% : 일일 제한 치환 대상이 정확히 1곳이어야 해요(현재 %곳)', v_sig, v_n; end if;
        select count(*) into v_n from regexp_matches(v_def, 'if\s+coalesce\(v_pmc_enabled,\s*false\)\s+and\s+v_pmc_limit\s+is\s+not\s+null\s+then', 'gi');
        if v_n <> 1 then raise exception '% : 프라이빗 동시 제한 치환 대상이 정확히 1곳이어야 해요(현재 %곳)', v_sig, v_n; end if;

        v_var := (regexp_match(v_def, 'where\s+r\.profile_id\s*=\s*(\w+)', 'i'))[1];     -- 일일 제한 집계의 프로필 변수(함수마다 다름)
        if v_var is null then raise exception '% : 프로필 변수를 찾지 못했어요', v_sig; end if;

        v_def := regexp_replace(v_def, '(if\s+coalesce\(v_daily_enabled,\s*false\)\s+and\s+v_daily_limit\s+is\s+not\s+null\s+then)',
                 E'\\1 perform pg_advisory_xact_lock(hashtextextended(''daily-limit:'' || ' || v_var || '::text || '':'' || v_local_date::text, 0)); -- limit-race-lock', 'i');
        v_def := regexp_replace(v_def, '(if\s+coalesce\(v_pmc_enabled,\s*false\)\s+and\s+v_pmc_limit\s+is\s+not\s+null\s+then)',
                 E'\\1 perform pg_advisory_xact_lock(hashtextextended(''private-concurrent:'' || v_class.center_id::text, 0)); -- limit-race-lock', 'i');
        execute v_def;
    end loop;
end
$patch$;
