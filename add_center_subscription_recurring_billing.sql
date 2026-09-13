-- ============================================================
-- 센터 → 플랫폼 월 구독료 — 2회차 이후 자동 청구(매월 정기 청구) 스케줄러
--
-- 배경: add_center_platform_subscription.sql은 의도적으로 "매월 자동 청구 실행"을
-- 범위 밖에 뒀고(pg_cron/외부 스케줄러 필요), app/api/billing/confirm/route.ts는
-- 최초 1회(카드 등록 시점) 결제만 처리한다. docs/TODO.md P0-8 완료조건 (3)이 이 갭을
-- 그대로 지목하고 있다 — 토스에 "별도 해지 신청이 없는 한 매월 자동으로 갱신·청구된다"고
-- 설명하려면 실제로 그 청구를 실행하는 코드가 있어야 한다.
--
-- 패턴 선택: 이 저장소의 기존 스케줄러(add_autocancel_scheduler.sql, add_notification_
-- scheduler.sql)는 전부 "pg_cron이 Edge Function을 깨우고, Edge Function이 service_role로
-- Postgres RPC를 부른다"인데, 이번엔 다르게 pg_cron이 **Edge Function을 거치지 않고 이
-- 앱의 Next.js API 라우트(app/api/billing/charge-due/route.ts)를 직접 호출**하도록
-- 했다. 이유: 토스 시크릿 키(TOSS_SECRET_KEY)를 쓰는 실제 결제 호출 로직이 이미
-- app/api/billing/confirm/route.ts(Next.js, Vercel 환경변수)에 있는데, 이걸 Edge
-- Function으로 옮기거나 복제하면 TOSS_SECRET_KEY를 Vercel과 Supabase Edge Function
-- secrets 두 곳에 따로 보관/교체해야 해서(add_center_alimtalk_addon_billing.sql의
-- ALIGO_* 키처럼 Edge Function 전용 API는 원래도 그렇게 하지만, 이건 "이미 Vercel에
-- 있는 시크릿을 다시 Supabase에도 두는" 불필요한 중복이라 다르다) 시크릿 보관 위치가
-- 늘어난다. pg_net(net.http_post)은 이미 이 프로젝트에서 검증된 확장이라(add_autocancel_
-- scheduler.sql) Vercel URL을 직접 호출해도 안전성은 동일 — 그래서 Edge Function
-- 단계를 생략하고 한 홉 줄였다. 인증은 서비스 role key 대신 새 vault 시크릿
-- billing_cron_secret(아래 [3])으로 한다 — Next.js 라우트가 Supabase 서비스 role
-- key를 검증할 방법이 없기 때문(그건 Supabase 전용 JWT).
--
-- 하는 일:
--   1) center_subscriptions.billing_locked_until — 중복 청구 방지용 리스(lease) 마커
--   2) center_subscription_charges.order_id — 토스에 보낸 orderId 기록(감사/디버깅용,
--      결제 자체의 유일성은 이미 amount/status/charged_at으로 추적 가능하지만 토스
--      쪽 문의 시 이 값이 있어야 대조 가능)
--   3) vault에 billing_cron_secret 자리만 마련(값은 이 파일이 채우지 않음 — 아래 참고)
--   4) pg_cron: 하루 1회(사용자 지시 — "cron 주기는 과도하게 짧게 만들지 말 것") Next.js
--      /api/billing/charge-due를 net.http_post로 호출
--
-- 이 파일이 하지 않는 것(의도적, docs/TODO.md에 기록):
--   - 연체(past_due) 재시도 횟수 제한/유예기간 만료 후 자동 해지 등 "정교한 연체 정책"
--     — 지금은 "실패하면 past_due로 표시하고 매일 재시도, 성공하면 active로 복귀"만 함.
--     몇 번 실패하면 포기하고 해지할지는 사업 결정 사항(P0-8 완료조건 (4), 그대로 둠).
--   - past_due 상태에서 오너가 카드를 직접 재등록/재시도하는 UI — 지금 매니저 화면은
--     status==='pending_billing_setup'일 때만 "카드 등록" 버튼을 보여준다. past_due는
--     같은 카드로 자동 재시도가 계속되므로 당장 막힌 건 아니지만, 카드를 바꿔야 하는
--     경우엔 현재 화면에서 할 수 있는 게 없다 — 별도 작업 필요.
--
-- 실행 순서(중요, 순서를 지킬 것):
--   1) 이 파일을 Supabase SQL Editor에서 실행(테이블 컬럼 + cron job 등록)
--      ⚠ 이 시점에 cron job이 이미 등록되지만, billing_cron_secret이 비어있는 채로
--      실행하면 매일 인증 실패(401) 응답만 받고 끝난다(과금 없음, 안전) — 그래도
--      아래 2)~3)을 먼저 끝내고 이 파일을 실행하는 순서를 권장한다.
--   2) Vercel에 새 환경변수 BILLING_CRON_SECRET 추가(임의의 긴 무작위 문자열 —
--      `openssl rand -hex 32` 등으로 직접 생성. 이 값을 Claude에게 보여주거나
--      대화에 붙여넣지 말 것 — 시크릿이라 대화 기록에 남으면 안 됨)
--   3) 아래 [3] 섹션의 `select vault.create_secret(...)` 줄 주석을 풀고 '__PASTE_SAME_
--      VALUE_AS_VERCEL_BILLING_CRON_SECRET__' 부분만 2)에서 만든 값으로 직접 바꿔서
--      실행(따로, 이 파일 나머지 부분과 별개로 실행해도 됨) — 두 값이 정확히 같아야
--      인증이 통과한다.
--   4) 배포 후 확인: select jobname, schedule, active from cron.job where jobname =
--      'dispatch-center-billing'; 그리고 며칠 뒤
--      select * from net._http_response order by created desc limit 5; 로 실제
--      요청이 200을 받는지 확인.
--
-- 여러 번 실행해도 안전(add column if not exists / cron.schedule은 동일 이름 재호출 시
-- 기존 스케줄을 덮어씀).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] center_subscriptions — 중복 청구 방지용 리스 마커
-- ------------------------------------------------------------
alter table center_subscriptions add column if not exists billing_locked_until timestamptz;

comment on column center_subscriptions.billing_locked_until is
    '자동 청구 처리 중 잠금(리스) 만료 시각. app/api/billing/charge-due가 청구 대상을 ' ||
    '고를 때 UPDATE...WHERE (billing_locked_until is null or < now())로 원자적으로 ' ||
    '선점해 같은 구독이 동시에 두 번 청구되는 것을 막는다. 처리가 끝나면(성공/실패 ' ||
    '무관) 항상 null로 해제한다 — 만약 서버가 처리 도중 죽어서 해제가 안 되더라도 ' ||
    '리스가 만료되면(15분) 다음 실행에서 다시 집힐 수 있다.';

-- ------------------------------------------------------------
-- [2] center_subscription_charges — 토스 orderId 기록(감사용)
-- ------------------------------------------------------------
alter table center_subscription_charges add column if not exists order_id text;

comment on column center_subscription_charges.order_id is
    '토스에 보낸 주문번호. 정기 청구는 sub-recur-{centerId}-{그 회차의 next_billing_date} ' ||
    '형태로 결정적으로 만든다(app/api/billing/charge-due) — 같은 회차를 재시도해도 ' ||
    '동일한 orderId를 재사용해서, 토스 쪽 orderId 유일성 제약이 이중 청구를 한 번 더 ' ||
    '막아준다(DB 리스가 실패하더라도 토스가 중복 orderId를 거부).';

COMMIT;

-- ------------------------------------------------------------
-- [3] vault 시크릿 자리 — billing_cron_secret
--
-- ⚠ 아래 주석을 풀어서 직접 실행하기 전에 '__PASTE_SAME_VALUE_AS_VERCEL_BILLING_CRON_
-- SECRET__' 부분을 Vercel에 등록한 BILLING_CRON_SECRET과 정확히 같은 값으로 바꿀 것.
-- 이 파일에는 실제 값을 적어두지 않는다(시크릿을 커밋/대화에 남기지 않기 위함).
-- ------------------------------------------------------------
-- select vault.create_secret(
--     '__PASTE_SAME_VALUE_AS_VERCEL_BILLING_CRON_SECRET__',
--     'billing_cron_secret',
--     'app/api/billing/charge-due 인증용 — Vercel BILLING_CRON_SECRET과 반드시 동일해야 함'
-- );

-- ------------------------------------------------------------
-- [4] 하루 1회 정기 청구 디스패치 — 매일 01:00 UTC(=한국시간 오전 10시)
-- daily-notifications(00:00 UTC)와 겹치지 않게 1시간 띄움.
-- ------------------------------------------------------------
select cron.schedule(
    'dispatch-center-billing',
    '0 1 * * *',
    $$
    select net.http_post(
        url := 'https://mwhabit.com/api/billing/charge-due',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', (
                select decrypted_secret from vault.decrypted_secrets
                where name = 'billing_cron_secret' limit 1
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
where table_name = 'center_subscriptions' and column_name = 'billing_locked_until';
select column_name from information_schema.columns
where table_name = 'center_subscription_charges' and column_name = 'order_id';
select jobname, schedule, active from cron.job where jobname = 'dispatch-center-billing';
select count(*) as billing_cron_secret_registered from vault.decrypted_secrets where name = 'billing_cron_secret';
