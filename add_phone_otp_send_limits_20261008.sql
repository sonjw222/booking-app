-- ============================================================
-- send-phone-otp 남용 제한 — IP 기준 시간당 한도 + 전역 일일 안전 한도 (보안 감사 P2, 2026-10-08)
-- ============================================================
-- 문제: send-phone-otp는 anon 호출 공개 엔드포인트이고 제한이 "번호별"(60초 쿨다운, 시간당 5회)뿐이라, 서로 다른 번호를 순회하면
--       Aligo 발송 비용을 소모시키고 제3자 번호에 SMS를 보낼 수 있다. 번호별 제한은 그대로 두고 두 겹을 더한다:
--         · 같은 클라이언트(IP 해시)당 1시간에 기본 10회
--         · 프로젝트 전체 24시간 기본 500회(안전 상한 — 비정상 폭주 시 비용 상한)
-- 구조: check-signup-email의 consume_email_check_attempt와 같은 패턴(IP는 SHA-256 해시만 저장, RLS 켜고 정책 없음 = service_role 전용,
--       advisory lock으로 확인+기록을 원자적으로). 한도 값은 RPC 인자 기본값이라 Edge Function(OTP_IP_HOURLY_CAP / OTP_GLOBAL_DAILY_CAP 환경변수)에서 조정 가능.
-- 반환: 'ok'(허용+기록) | 'ip_limit' | 'global_limit'(기록하지 않음). 2일 지난 기록은 호출 때 함께 정리한다.
-- DEV 우회(PHONE_OTP_TEST_BYPASS_PREFIX 번호)는 실제 SMS를 보내지 않으므로 Edge Function이 이 RPC를 호출하지 않는다 — 한도에 영향 없음.
-- 롤백: rollback_add_phone_otp_send_limits_20261008.sql. 이 SQL은 Claude Code 세션에서 실행되지 않았다(사용자가 SQL Editor에서 직접 확인 후 실행).
-- 배포 순서 권장: 이 SQL 먼저 → Edge Function 배포(함수는 RPC가 아직 없으면 "정의되지 않은 함수" 오류에 한해 fail-open + 로그).
-- ============================================================

create table if not exists phone_otp_send_attempts (
    id          uuid primary key default gen_random_uuid(),
    ip_hash     text not null,
    created_at  timestamptz not null default now()
);

create index if not exists idx_phone_otp_send_attempts_ip_created
    on phone_otp_send_attempts (ip_hash, created_at desc);
create index if not exists idx_phone_otp_send_attempts_created
    on phone_otp_send_attempts (created_at desc);

alter table phone_otp_send_attempts enable row level security;
grant select, insert on phone_otp_send_attempts to service_role;

create or replace function consume_phone_otp_send_attempt(
    p_ip_hash text,
    p_ip_hourly_cap int default 10,
    p_global_daily_cap int default 500
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_ip_count int;
    v_global_count int;
begin
    if p_ip_hash is null or length(p_ip_hash) = 0 then
        raise exception 'ip hash required';
    end if;

    -- OTP 발송은 저빈도라 전역 락 하나로 직렬화해도 충분하다(IP별 한도와 전역 한도를 한 번에 원자적으로 판정).
    perform pg_advisory_xact_lock(hashtextextended('phone_otp_send_attempts', 0));

    delete from public.phone_otp_send_attempts where created_at < now() - interval '2 days';

    select count(*) into v_ip_count
    from public.phone_otp_send_attempts
    where ip_hash = p_ip_hash and created_at >= now() - interval '1 hour';
    if v_ip_count >= greatest(p_ip_hourly_cap, 1) then
        return 'ip_limit';
    end if;

    select count(*) into v_global_count
    from public.phone_otp_send_attempts
    where created_at >= now() - interval '24 hours';
    if v_global_count >= greatest(p_global_daily_cap, 1) then
        return 'global_limit';
    end if;

    insert into public.phone_otp_send_attempts (ip_hash) values (p_ip_hash);
    return 'ok';
end;
$$;

revoke all on function consume_phone_otp_send_attempt(text, int, int) from public;
revoke all on function consume_phone_otp_send_attempt(text, int, int) from anon;
revoke all on function consume_phone_otp_send_attempt(text, int, int) from authenticated;
grant execute on function consume_phone_otp_send_attempt(text, int, int) to service_role;
