-- ============================================================
-- 웹 푸시 알림 (P1-3 일부 — 브라우저/OS 푸시. 카카오 알림톡·SMS는 사업자 등록이
-- 필요해 범위 밖, docs/TODO.md P1-3 참고)
--
-- 하는 일:
--   1) push_subscriptions 테이블 — 브라우저가 발급한 푸시 구독 정보 저장
--   2) notifications.pushed_at 컬럼 — 이미 웹 푸시로 내보낸 알림 표시(중복 발송 방지)
--   3) pg_net 확장 — Postgres에서 Edge Function을 HTTPS로 호출하기 위함
--      (VAPID 서명·암호화 푸시 페이로드 생성은 SQL로 불가능해 Edge Function에 위임)
--   4) pg_cron으로 1분마다 send-web-push Edge Function을 호출해 미발송 알림을 처리
--
-- ⚠ 이 파일을 실행하기 전에 아래를 먼저 해야 합니다(이 파일에는 비밀값을 넣지 않음 —
--    CLAUDE.md 규칙 5, 비밀키는 코드/Git에 저장 금지):
--   1) supabase functions deploy send-web-push  (Edge Function 배포)
--   2) supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:...
--      (VAPID 키는 로컬에서 `npx web-push generate-vapid-keys`로 생성, 대화창에서 전달받은 값 사용)
--   3) SQL Editor에서 아래를 직접 실행해 SERVICE_ROLE_KEY를 Vault에 저장(이 파일에는 없음):
--      select vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY 값>', 'service_role_key', 'send-web-push cron 인증용');
--      (이미 'service_role_key'라는 이름의 vault secret이 있다면 생략)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create extension if not exists pg_net with schema extensions;

-- ------------------------------------------------------------
-- 푸시 구독 테이블
--   account_id : 구독한 계정 (회원/매니저 공통)
--   endpoint   : 브라우저가 발급한 푸시 서비스 URL (기기·브라우저별로 고유)
--   p256dh/auth: Web Push 암호화 키 (RFC 8291)
-- ------------------------------------------------------------
create table if not exists push_subscriptions (
    id          uuid primary key default gen_random_uuid(),
    account_id  uuid not null references accounts(id) on delete cascade,
    endpoint    text not null unique,
    p256dh      text not null,
    auth        text not null,
    user_agent  text,
    created_at  timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_account
    on push_subscriptions(account_id);

alter table push_subscriptions enable row level security;

drop policy if exists "푸시 구독 본인 조회" on push_subscriptions;
create policy "푸시 구독 본인 조회"
    on push_subscriptions for select
    using (account_id = my_account_id());

drop policy if exists "푸시 구독 본인 등록" on push_subscriptions;
create policy "푸시 구독 본인 등록"
    on push_subscriptions for insert
    with check (account_id = my_account_id());

drop policy if exists "푸시 구독 본인 삭제" on push_subscriptions;
create policy "푸시 구독 본인 삭제"
    on push_subscriptions for delete
    using (account_id = my_account_id());

grant select, insert, update, delete on push_subscriptions to service_role;

-- ------------------------------------------------------------
-- notifications에 발송 여부 컬럼 추가 (기존 add_notifications.sql 보완)
-- ------------------------------------------------------------
alter table notifications add column if not exists pushed_at timestamptz;

create index if not exists idx_notifications_unpushed
    on notifications(created_at) where pushed_at is null;

-- ------------------------------------------------------------
-- 1분마다 send-web-push Edge Function 호출 (미발송 알림을 실제 브라우저 푸시로 전달)
-- cron.schedule()은 같은 job 이름으로 재호출하면 기존 스케줄을 덮어쓰므로
-- 이 파일을 다시 실행해도 안전.
-- ------------------------------------------------------------
select cron.schedule(
    'dispatch-web-push',
    '* * * * *',
    $$
    select net.http_post(
        url := 'https://bxntqggkfwnhcczsbqtj.supabase.co/functions/v1/send-web-push',
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
