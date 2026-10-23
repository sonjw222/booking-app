-- 자동 폐강 알림 중복 책임 정리 (2026-10-23) — 후속 SQL, 운영 직접 적용 금지(Codex 검토·적용 대상)
--
-- 원인(격리 재현: extra-autocancel-isolated-1022.json + tests/rls-real/autocancel.rls.test.ts):
--   run_autocancel_sweep() 은 취소한 예약마다 회원에게 'admin_cancelled'(센터명 수업이 폐강됐어요 · 최소 인원 미달 · 횟수 복구 여부)를 직접 보낸다.
--   그런데 같은 UPDATE(reservations.status → 'cancelled')가 trg_notify_reservation_update 트리거도 실행해 같은 회원에게
--   'reservation_canceled'(예약이 취소됐어요)를 또 만든다 → 같은 수신자가 한 번의 폐강에 두 알림을 받는다.
-- 정리: 알림 책임을 스윕(폐강 사유를 아는 쪽)에 둔다. 스윕이 트랜잭션 로컬 플래그 app.system_class_cancel='on' 을 켜 두고,
--   트리거는 이 플래그가 켜진 동안 "회원에게 가는 reservation_canceled"만 건너뛴다.
--   · 센터 직원에게 가는 reservation_canceled 알림은 기존 그대로(변경 없음 — 정책 변경 아님)
--   · 일반 취소(회원 본인 취소, 관리자 취소, 대기 승격 등)의 알림은 플래그가 없으므로 그대로
--   · 플래그는 set_config(..., true)=트랜잭션 로컬이고 스윕이 끝나기 전에 비우므로 다른 세션/문장에 새지 않는다
-- 적용 방식: 운영 정의가 저장소와 다를 수 있어 pg_get_functiondef 결과를 정확히 한 군데씩 치환한다(0건/2건 이상이면 중단). 마커 주석으로 재실행은 무시.
-- 호환: 앱 코드 변경 없음. 알림 유형(admin_cancelled/reservation_canceled) 이름·본문 불변, 중복만 제거. 운영 cron·외부 푸시는 이 SQL 로 실행/변경하지 않는다.

do $patch$
declare
    v_trg   text;
    v_sweep text;
    v_n     integer;
begin
    v_trg   := pg_get_functiondef('public.trg_notify_reservation_update()'::regprocedure);
    v_sweep := pg_get_functiondef('public.run_autocancel_sweep()'::regprocedure);

    -- pg_get_functiondef 는 키워드를 대문자로 정규화하므로 모든 매칭은 대소문자 무시('i')다.
    if v_trg not like '%-- sys-cancel-dedupe%' then
        select count(*) into v_n from regexp_matches(v_trg, 'if v_account is not null then(\s+)perform push_notification\((\s+)v_account, ''reservation_canceled''', 'gi');
        if v_n <> 1 then raise exception 'trg_notify_reservation_update: 치환 대상이 정확히 1곳이어야 해요(현재 %곳)', v_n; end if;
        v_trg := regexp_replace(v_trg,
            'if v_account is not null then(\s+)perform push_notification\((\s+)v_account, ''reservation_canceled''',
            'if v_account is not null and coalesce(current_setting(''app.system_class_cancel'', true), '''') <> ''on'' then -- sys-cancel-dedupe' || E'\\1' || 'perform push_notification(' || E'\\2' || 'v_account, ''reservation_canceled''',
            'i');
        execute v_trg;
    end if;

    if v_sweep not like '%-- sys-cancel-dedupe%' then
        select count(*) into v_n from regexp_matches(v_sweep, 'v_center_name text;(\s*)begin', 'gi');
        if v_n <> 1 then raise exception 'run_autocancel_sweep: 시작부 치환 대상이 정확히 1곳이어야 해요(현재 %곳)', v_n; end if;
        select count(*) into v_n from regexp_matches(v_sweep, 'return json_build_object\((\s*)''classes_cancelled''', 'gi');
        if v_n <> 1 then raise exception 'run_autocancel_sweep: 종료부 치환 대상이 정확히 1곳이어야 해요(현재 %곳)', v_n; end if;
        v_sweep := regexp_replace(v_sweep, 'v_center_name text;(\s*)begin',
            'v_center_name text;' || E'\\1' || 'begin' || E'\\1' || '    perform set_config(''app.system_class_cancel'', ''on'', true); -- sys-cancel-dedupe: 이 스윕이 회원 알림(admin_cancelled)을 직접 보낸다',
            'i');
        v_sweep := regexp_replace(v_sweep, 'return json_build_object\((\s*)''classes_cancelled''',
            'perform set_config(''app.system_class_cancel'', '''', true);' || E'\n    ' || 'return json_build_object(' || E'\\1' || '''classes_cancelled''',
            'i');
        execute v_sweep;
    end if;
end
$patch$;
