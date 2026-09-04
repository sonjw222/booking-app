-- ============================================================
-- 네이티브 앱(iOS/Android, Capacitor) 푸시 토큰 — FCM 기반
--
-- add_web_push.sql의 push_subscriptions(VAPID 웹푸시)와 별개 테이블이다. iOS 네이티브
-- WebView(WKWebView)는 VAPID 기반 웹푸시 구독 자체를 지원하지 않아 네이티브 앱에서는
-- FCM(Firebase Cloud Messaging)으로 별도 발송해야 한다 — 대신 발송 파이프라인은 새로
-- 안 만들고 send-web-push Edge Function을 확장해 같은 notifications.pushed_at 기준으로
-- 웹/네이티브 양쪽에 함께 내보낸다(fix_send_web_push_add_fcm.sql 또는 해당 함수 코드 참고).
--
-- ⚠ 이 파일을 실행하기 전에(또는 실행 후) 아래를 해야 실제로 네이티브 푸시가 나간다:
--   1) Firebase 프로젝트 생성 + 서비스 계정 키 발급
--   2) supabase secrets set FCM_PROJECT_ID=... FCM_CLIENT_EMAIL=... FCM_PRIVATE_KEY=...
--   3) supabase functions deploy send-web-push (FCM 발송 코드 포함해 재배포)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- 네이티브 푸시 토큰 테이블
--   account_id : 등록한 계정 (회원/매니저 공통, push_subscriptions와 동일)
--   platform   : "ios" | "android" — 발송 시 페이로드 형식 분기에 사용 가능
--   token      : FCM이 발급한 기기 등록 토큰(앱 재설치·재로그인 시 재발급되어 갱신됨)
-- ------------------------------------------------------------
create table if not exists native_push_tokens (
    id          uuid primary key default gen_random_uuid(),
    account_id  uuid not null references accounts(id) on delete cascade,
    platform    text not null check (platform in ('ios', 'android')),
    token       text not null unique,
    updated_at  timestamptz not null default now(),
    created_at  timestamptz not null default now()
);

create index if not exists idx_native_push_tokens_account
    on native_push_tokens(account_id);

alter table native_push_tokens enable row level security;

drop policy if exists "네이티브 푸시 토큰 본인 조회" on native_push_tokens;
create policy "네이티브 푸시 토큰 본인 조회"
    on native_push_tokens for select
    using (account_id = my_account_id());

drop policy if exists "네이티브 푸시 토큰 본인 등록" on native_push_tokens;
create policy "네이티브 푸시 토큰 본인 등록"
    on native_push_tokens for insert
    with check (account_id = my_account_id());

-- 토큰 갱신(같은 기기, 같은 account) — upsert on conflict(token) 대비
drop policy if exists "네이티브 푸시 토큰 본인 수정" on native_push_tokens;
create policy "네이티브 푸시 토큰 본인 수정"
    on native_push_tokens for update
    using (account_id = my_account_id())
    with check (account_id = my_account_id());

drop policy if exists "네이티브 푸시 토큰 본인 삭제" on native_push_tokens;
create policy "네이티브 푸시 토큰 본인 삭제"
    on native_push_tokens for delete
    using (account_id = my_account_id());

grant select, insert, update, delete on native_push_tokens to service_role;
