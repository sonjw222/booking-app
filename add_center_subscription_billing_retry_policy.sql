-- ============================================================
-- 센터 정기결제 실패(연체) 정책 확정 반영 — 최대 7회/7일 재시도 후 자동중지
--
-- 배경: add_center_subscription_recurring_billing.sql은 "실패하면 past_due로 표시하고
-- 성공할 때까지 매일 무한 재시도"만 구현했고, 재시도 횟수 제한/최종 중지 정책은 사업
-- 결정 사항으로 미뤄뒀다(docs/TODO.md P0-8 완료조건 (4)). 사용자가 2026-09-14 아래
-- 정책을 확정:
--   - 실패 시 past_due, 하루 1회 재시도, 최대 7회(=최대 유예기간 7일)
--   - 재시도 성공 시 active 복귀 + 카운트 초기화
--   - 7회 모두 실패하면 자동 재시도 중단 + 기존 4개 상태(pending_billing_setup/active/
--     past_due/canceled) 중 적합한 게 없어 새 terminal 상태 필요 → payment_failed로 명명
--     ("suspended"보다 원인이 결제 실패임을 명확히 드러내는 이름을 선택)
--   - 카드 만료/분실/정지 등 재시도해도 성공 가능성이 없는 오류는 즉시 payment_failed
--     (7회를 채우지 않고 바로 중단 — 불필요한 반복 청구 방지)
--   - payment_failed 상태에서도 billing_key 등 기존 카드 정보는 삭제하지 않음(감사용
--     보존) — 새 카드 등록(app/api/billing/confirm/route.ts, 이번에 payment_failed도
--     대상에 포함하도록 확장)으로만 active 복귀 가능
--
-- 하는 일:
--   1) center_subscriptions.retry_count — 연속 실패 횟수(성공 시 0으로 리셋)
--   2) status CHECK 제약에 'payment_failed' 추가(5번째 값)
--
-- 이 파일이 하지 않는 것:
--   - payment_failed 상태에서 오너가 아닌 운영자가 강제로 재개하는 RPC(기존
--     admin_reactivate_center_subscription은 canceled 전용으로 그대로 둠 — 이번
--     정책은 "오너가 새 카드 등록"이 유일한 재개 경로라고 명시했으므로 범위 밖)
--   - 실제 로직(재시도 카운트 증가/판정, 토스 오류코드 분류)은 app/api/billing/
--     charge-due/route.ts와 app/api/billing/confirm/route.ts(코드 변경, 이 파일과 별개)
--
-- 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전
-- (add column if not exists / constraint는 drop 후 재생성이라 두 번째 실행부터도
-- 동일한 최종 상태로 수렴).
-- ============================================================

BEGIN;

alter table center_subscriptions add column if not exists retry_count integer not null default 0;

comment on column center_subscriptions.retry_count is
    '정기 청구 연속 실패 횟수. 성공하면 0으로 리셋(app/api/billing/charge-due). '
    '7에 도달하면 status가 payment_failed로 전환되고 자동 재시도 대상에서 제외된다. '
    '카드 만료/분실 등 재시도 무의미한 오류는 이 값과 무관하게 즉시 payment_failed로 '
    '전환될 수 있다(app/api/billing/charge-due의 오류코드 분류 참고).';

alter table center_subscriptions drop constraint if exists center_subscriptions_status_check;
alter table center_subscriptions add constraint center_subscriptions_status_check
    check (status in ('pending_billing_setup', 'active', 'past_due', 'canceled', 'payment_failed'));

comment on column center_subscriptions.status is
    'pending_billing_setup(카드 미등록) / active(정상) / past_due(청구 실패, 자동 재시도 중, '
    '최대 7일) / payment_failed(7회 재시도 소진 또는 재시도 무의미한 오류로 자동중지 — 새 '
    '카드 등록 전까지 청구 안 됨) / canceled(오너가 직접 해지)';

COMMIT;

-- ============================================================
-- 확인
-- ============================================================
select column_name, column_default from information_schema.columns
where table_name = 'center_subscriptions' and column_name = 'retry_count';
select pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'center_subscriptions'::regclass and conname = 'center_subscriptions_status_check';
