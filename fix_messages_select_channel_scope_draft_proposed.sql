-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- messages SELECT 정책 channel 분리 수정 (Batch A1 검증 중 발견된 결함 수정)
--
-- 배경: proposed_rls_gap_batch_a1.sql 적용 후 tests/integration/sec009-batch-a1-rls.test.ts
-- 실행 결과, messages의 SELECT 정책만 channel로 나뉘지 않고 두 permission을 단순 OR로
-- 묶어놓은 결함이 발견됨(INSERT/UPDATE/DELETE 정책은 원래부터 channel로 정확히 분리돼
-- 있었음 — SELECT만 놓친 것). 그 결과 message.sms.view만 가진 스태프도 push 채널
-- 메시지를 볼 수 있고 그 반대도 마찬가지였음(37/38 통과, 이 1건만 실패로 확인됨).
--
-- 현재(수정 전) 적용된 정책 — 2026-08-02, proposed_rls_gap_batch_a1.sql 실행 결과로 확인:
--   create policy "발송이력 조회"
--       on messages for select
--       using (
--           has_permission(center_id, 'message.sms.view')
--           or has_permission(center_id, 'message.push.view')
--       );
--
-- 이 파일은 messages의 SELECT 정책 1개만 수정합니다. staff_salaries/leads(이미 정상 동작)와
-- messages의 INSERT/UPDATE/DELETE 정책(원래부터 올바르게 channel 분리돼 있음)은 전혀
-- 건드리지 않습니다. RLS 자체는 비활성화하지 않습니다. 짝 파일:
-- rollback_fix_messages_select_channel_scope_draft_proposed.sql
-- ============================================================

BEGIN;

drop policy if exists "발송이력 조회" on messages;
create policy "발송이력 조회"
    on messages for select
    using (
        (channel in ('sms', 'lms') and has_permission(center_id, 'message.sms.view'))
        or (channel = 'push' and has_permission(center_id, 'message.push.view'))
    );

COMMIT;
