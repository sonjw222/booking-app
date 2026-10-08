-- ============================================================
-- 알림톡 큐 디스패치 — 원자적 선점 + 중복 발송 방지 + service_role 권한 (2026-10-08)
-- ============================================================
-- 배경(운영 안정성 감사): pg_cron "dispatch-alimtalk"가 매분 status='scheduled' messages 행마다 send-alimtalk를 호출한다.
--   · 발송 전에 행을 선점하지 않아(상태가 수신자 루프 종료 후에야 바뀜) 겹치는 실행이 같은 수신자에게 중복 발송할 수 있고,
--   · notification_logs에 message 연결이 없어 중간에 끊긴 실행을 재개할 수 없으며,
--   · (⚠ 별개 발견) Production의 service_role에는 messages에 DELETE 권한만 있다(fix_service_role_grants_full_audit.sql의
--     "grant delete on messages to service_role") — send-alimtalk가 service_role로 messages를 SELECT/UPDATE하므로 그 상태로는
--     "permission denied for table messages"가 나 큐 디스패치가 동작하지 못한다. 아래 GRANT는 최소 권한(SELECT + 3개 컬럼 UPDATE)만 추가한다.
--     운영에서 실제로 막혀 있는지는 verify 파일의 has_table_privilege 조회로 먼저 확인할 수 있다.
-- 변경:
--   1) messages.claimed_at — 선점(처리 중) 표식. 새 status 값을 추가하지 않는다(messages_status_check 변경 없음).
--   2) notification_logs.message_id(+error) — 수신자별 발송 기록을 메시지에 연결(실패 사유는 200자 이내).
--   3) (message_id, profile_id) 'sent' 부분 유일 인덱스 — 같은 수신자에게 'sent' 로그가 두 번 생기지 못한다(디스패처가 이를 보고 건너뜀).
--   4) service_role: messages SELECT + UPDATE(status, sent_at, claimed_at).
-- 기존 행/RLS/정책/함수는 건드리지 않는다. 롤백: rollback_fix_alimtalk_dispatch_claim_20261008.sql
-- ⚠ 이 SQL은 Claude Code 세션에서 실행되지 않았다 — 실행은 사용자가 Supabase SQL Editor에서 직접 확인 후 진행.
-- ============================================================

alter table public.messages
    add column if not exists claimed_at timestamptz;
comment on column public.messages.claimed_at is
    '큐 디스패치(send-alimtalk) 선점 시각. status=scheduled이면서 이 값이 임대 시간(10분) 안이면 다른 실행이 잡지 못한다. 재시도 가능한 실패 후에는 null로 풀린다.';

alter table public.notification_logs
    add column if not exists message_id uuid references public.messages(id) on delete set null,
    add column if not exists error text;
comment on column public.notification_logs.message_id is '큐 메시지(messages.id)에서 발송된 건이면 그 메시지. 즉시 발송/규칙 이외 건은 null.';
comment on column public.notification_logs.error is '실패 사유(200자 이내). 비밀값/수신자 정보를 넣지 않는다.';

create unique index if not exists uq_notification_logs_message_profile_sent
    on public.notification_logs (message_id, profile_id)
    where status = 'sent' and message_id is not null;

create index if not exists idx_notification_logs_message_id
    on public.notification_logs (message_id)
    where message_id is not null;

grant select on public.messages to service_role;
grant update (status, sent_at, claimed_at) on public.messages to service_role;
