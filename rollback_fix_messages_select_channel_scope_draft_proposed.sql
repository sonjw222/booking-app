-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_messages_select_channel_scope_draft_proposed.sql was applied ⚠️
-- messages SELECT 정책 channel 분리 수정 — 롤백
--
-- 이 파일은 fix_messages_select_channel_scope_draft_proposed.sql 적용 직전의 상태
-- (proposed_rls_gap_batch_a1.sql이 만든, channel 분리가 안 된 원래 정책)로만 되돌립니다.
-- Batch A1 전체(staff_salaries/leads/messages 전부 정책 0건 상태)로 되돌리는 것이
-- 아닙니다 — 그건 rollback_rls_gap_batch_a1.sql의 역할이며 이 파일은 그것과 다릅니다.
-- RLS 자체는 비활성화하지 않습니다.
-- ============================================================

BEGIN;

drop policy if exists "발송이력 조회" on messages;
create policy "발송이력 조회"
    on messages for select
    using (
        has_permission(center_id, 'message.sms.view')
        or has_permission(center_id, 'message.push.view')
    );

COMMIT;
