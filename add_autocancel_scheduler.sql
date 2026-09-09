-- ============================================================
-- 수업 폐강 시간(자동 폐강) 실제 기능화 — pg_cron + Edge Function 스케줄러
--
-- 배경: center_settings.autocancel_hours/autocancel_minutes(schema.sql)는 저장은 되지만
-- 지금까지 아무 코드도 읽지 않아 "준비 중" 배지가 붙어있었다. classes.autocancel_deadline_min
-- 컬럼도 schema.sql에 있지만 grep 결과 어떤 함수도 이 컬럼을 채우거나 읽지 않는다(죽은 컬럼) —
-- create_class_safe 등을 새로 건드리는 대신, 센터 설정값을 스윕 시점에 직접 읽는 더 단순한
-- 방식을 쓴다(사용자 확인 없이 그 함수들을 고치는 리스크를 피함).
--
-- "최소 인원 미달 시 시작 전 자동 폐강"은 예약 취소처럼 사용자 행동이 트리거가 아니라
-- 시간이 흘러야만 감지되는 조건이라, 이미 이 저장소에 있는 dispatch-web-push/
-- dispatch-alimtalk와 동일한 "pg_cron이 1분마다 Edge Function을 깨우고, Edge Function이
-- service_role로 RPC를 부른다" 패턴을 그대로 재사용한다.
--
-- 사용자 명시 요청(2026-09-09): 기능은 실제로 만들되, 새 on/off 토글을 추가하고 기본값은
-- 꺼짐(autocancel_enabled = false) — 아무 센터도 의도치 않게 자동폐강을 겪지 않도록.
--
-- 하는 일:
--   1) center_settings.autocancel_enabled 컬럼 추가(기본 false)
--   2) run_autocancel_sweep() RPC — service_role 전용(일반 사용자/anon 실행 금지).
--      autocancel_enabled=true인 센터의, 최소인원 미달 + 시작 전 (autocancel_hours,
--      autocancel_minutes) 시점을 지난 open 수업을 찾아 cancelled 처리한다. 취소되는
--      예약(confirmed만 — waitlisted는 원래 remaining_count를 차감한 적이 없음, cancel_
--      reservation()과 동일한 판단 기준)의 수강권 remaining_count를 복구하고, 영향받는
--      회원 전원에게 push_notification()으로 admin_cancelled 알림을 보낸다.
--   3) pg_cron으로 1분마다 dispatch-autocancel Edge Function 호출(그 함수가 이 RPC를 부름)
--
-- ⚠ 이 파일 실행 전에 Edge Function을 먼저 배포해야 합니다:
--   supabase functions deploy dispatch-autocancel
--   (service_role_key vault secret은 add_web_push.sql 적용 시 이미 등록돼 있어 추가 작업 불필요)
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(add column if not exists / create or replace function /
-- cron.schedule은 같은 이름 재호출 시 기존 스케줄을 덮어씀).
-- ============================================================

alter table center_settings add column if not exists autocancel_enabled boolean not null default false;

-- ------------------------------------------------------------
-- 자동 폐강 스윕 — service_role 전용
-- ------------------------------------------------------------
create or replace function run_autocancel_sweep()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_class    record;
    v_res      record;
    v_restored boolean;
    v_cancelled_classes int := 0;
    v_cancelled_reservations int := 0;
    v_center_name text;
begin
    for v_class in
        select c.*
        from classes c
        join center_settings cs on cs.center_id = c.center_id
        where c.status = 'open'
          and cs.autocancel_enabled = true
          and now() < c.start_time
          and now() >= c.start_time - make_interval(hours => cs.autocancel_hours, mins => cs.autocancel_minutes)
          and c.min_capacity > (
              select count(*) from reservations r
              where r.class_id = c.id and r.status in ('confirmed', 'attended')
          )
        for update of c
    loop
        update classes set status = 'cancelled' where id = v_class.id;
        v_cancelled_classes := v_cancelled_classes + 1;

        select name into v_center_name from centers where id = v_class.center_id;

        for v_res in
            select * from reservations
            where class_id = v_class.id and status in ('confirmed', 'waitlisted', 'attended')
            for update
        loop
            v_restored := false;
            if v_res.status = 'confirmed' then
                update memberships set remaining_count = remaining_count + 1
                where id = v_res.membership_id
                  and status not in ('refunded', 'transferred')
                  and remaining_count is not null;
                v_restored := true;
            end if;

            update reservations
            set status = 'cancelled', cancel_source = 'SYSTEM', cancelled_at = now()
            where id = v_res.id;

            v_cancelled_reservations := v_cancelled_reservations + 1;

            perform push_notification(
                (select account_id from profiles where id = v_res.profile_id),
                'admin_cancelled',
                coalesce(v_center_name, '센터') || ' 수업이 폐강됐어요',
                v_class.title || ' (최소 인원 미달)' ||
                    case when v_restored then ' — 수강권 횟수가 복구됐어요' else '' end,
                v_class.center_id, '/my-reservations',
                jsonb_build_object('class_id', v_class.id)
            );
        end loop;
    end loop;

    return json_build_object(
        'classes_cancelled', v_cancelled_classes,
        'reservations_cancelled', v_cancelled_reservations
    );
end;
$$;

revoke all on function run_autocancel_sweep() from public;
revoke all on function run_autocancel_sweep() from anon;
revoke all on function run_autocancel_sweep() from authenticated;
grant execute on function run_autocancel_sweep() to service_role;

-- ------------------------------------------------------------
-- 1분마다 dispatch-autocancel Edge Function 호출
-- ------------------------------------------------------------
select cron.schedule(
    'dispatch-autocancel',
    '* * * * *',
    $$
    select net.http_post(
        url := 'https://bxntqggkfwnhcczsbqtj.supabase.co/functions/v1/dispatch-autocancel',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (
                select decrypted_secret from vault.decrypted_secrets
                where name = 'service_role_key' limit 1
            )
        ),
        body := '{}'::jsonb
    );
    $$
);

-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns
where table_name = 'center_settings' and column_name = 'autocancel_enabled';
select jobname, schedule, active from cron.job where jobname = 'dispatch-autocancel';
