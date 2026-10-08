-- fix_alimtalk_dispatch_claim_20261008.sql 롤백 — 추가한 컬럼/인덱스/권한만 되돌린다(기존 데이터·정책은 건드리지 않음).
-- ⚠ 롤백하면 send-alimtalk(이 변경 이후 코드)는 claimed_at/message_id 컬럼이 없어 큐 디스패치가 실패한다 — 함수도 이전 버전으로 되돌려야 한다.
revoke update (status, sent_at, claimed_at) on public.messages from service_role;
revoke select on public.messages from service_role;
drop index if exists public.idx_notification_logs_message_id;
drop index if exists public.uq_notification_logs_message_profile_sent;
alter table public.notification_logs drop column if exists error;
alter table public.notification_logs drop column if exists message_id;
alter table public.messages drop column if exists claimed_at;
