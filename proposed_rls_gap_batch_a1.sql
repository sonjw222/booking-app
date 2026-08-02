-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN ⚠️
-- RLS Gap Batch A1 — Batch A(민감정보 최우선) 중 통합 테스트로 검증 가능한 3개만 분리
-- 대상: staff_salaries, leads, messages
--
-- proposed_rls_gap_batch_a.sql(5개 테이블: staff_salaries/contracts/leads/messages/
-- notification_logs)에서 정책 내용 변경 없이 이 3개 테이블 부분만 그대로 분리했습니다.
-- contracts/notification_logs는 별도 조사(A2, docs/22_RLS_Gap_A2_Investigation.md)로
-- 미룹니다 — service_role GRANT 부재로 그 두 테이블은 fixture 생성·정리가 안전하게
-- 자동화되지 않아 통합 테스트 커버리지가 없는 상태로 함께 적용하면 회귀 시 원인 분리가
-- 어렵기 때문입니다(사용자 지적, 2026-08-02).
--
-- 실행 전 반드시: 1) docs/21_RLS_Gap_Analysis.md 검토 2) tests/integration/sec009-batch-a1-rls.test.ts
-- 통과 3) 사용자 명시적 승인. 짝 파일: rollback_rls_gap_batch_a1.sql
--
-- 재사용 헬퍼(기존 함수, 신규 없음): my_account_id(), has_permission(center_id, permission_key)
--
-- [2026-08-02 최종 안전 점검 완료]
--   - 16개 permission key(facility.salary.own/other.view/update ×4, customer.lead.* ×4,
--     message.sms.* ×4, message.push.* ×4) 전부 실제 permissions 카탈로그에 존재 확인
--     (16/16, 누락 0건 — 읽기 전용 조회로 확인, 임의 추가 없음).
--   - 3개 테이블 전부 여전히 "RLS 활성 + 정책 0건" 상태 재확인(오너 권한 INSERT 시도 →
--     42501 "new row violates row-level security policy"로 전부 차단 — 다른 정책이 새로
--     생기지 않았음을 간접 확인. 정책 목록 자체는 PostgREST로 직접 조회 불가).
--   - GRANT: anon/authenticated 둘 다 정상(이전 진단에서 확인) — 이 파일만으로 충분, 추가
--     GRANT 불필요. service_role만 GRANT 없음(테스트 도구 전용 문제, 앱 기능과 무관).
--   - DROP POLICY/CREATE POLICY를 하나의 트랜잭션(BEGIN/COMMIT)으로 묶어, 정책 부재 상태가
--     중간에 노출되는 시간을 없앴습니다. RLS 자체는 비활성화하지 않습니다.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- staff_salaries — Critical. own/other 권한 완전 분리(카탈로그의
-- facility.salary.own.*/facility.salary.other.* 그대로 사용).
-- ------------------------------------------------------------
alter table staff_salaries enable row level security;

drop policy if exists "급여 조회 (본인/타인 권한 분리)" on staff_salaries;
create policy "급여 조회 (본인/타인 권한 분리)"
    on staff_salaries for select
    using (
        (account_id = my_account_id() and has_permission(center_id, 'facility.salary.own.view'))
        or (account_id != my_account_id() and has_permission(center_id, 'facility.salary.other.view'))
    );

drop policy if exists "급여 등록 (본인/타인 권한 분리)" on staff_salaries;
create policy "급여 등록 (본인/타인 권한 분리)"
    on staff_salaries for insert
    with check (
        (account_id = my_account_id() and has_permission(center_id, 'facility.salary.own.update'))
        or (account_id != my_account_id() and has_permission(center_id, 'facility.salary.other.update'))
    );

drop policy if exists "급여 수정 (본인/타인 권한 분리)" on staff_salaries;
create policy "급여 수정 (본인/타인 권한 분리)"
    on staff_salaries for update
    using (
        (account_id = my_account_id() and has_permission(center_id, 'facility.salary.own.update'))
        or (account_id != my_account_id() and has_permission(center_id, 'facility.salary.other.update'))
    )
    with check (
        (account_id = my_account_id() and has_permission(center_id, 'facility.salary.own.update'))
        or (account_id != my_account_id() and has_permission(center_id, 'facility.salary.other.update'))
    );

-- DELETE: 카탈로그에 salary 전용 delete 권한 키가 없음 — other.update 권한으로 대체(초안 단계 한계, TODO P2-12 참고).
drop policy if exists "급여 삭제" on staff_salaries;
create policy "급여 삭제"
    on staff_salaries for delete
    using (has_permission(center_id, 'facility.salary.other.update'));


-- ------------------------------------------------------------
-- leads — High. customer.lead.* 권한 기준(카탈로그 그대로 사용, 변경 없음).
-- ------------------------------------------------------------
alter table leads enable row level security;

drop policy if exists "상담고객 조회" on leads;
create policy "상담고객 조회"
    on leads for select
    using (has_permission(center_id, 'customer.lead.view'));

drop policy if exists "상담고객 등록" on leads;
create policy "상담고객 등록"
    on leads for insert
    with check (has_permission(center_id, 'customer.lead.create'));

drop policy if exists "상담고객 수정" on leads;
create policy "상담고객 수정"
    on leads for update
    using (has_permission(center_id, 'customer.lead.update'))
    with check (has_permission(center_id, 'customer.lead.update'));

drop policy if exists "상담고객 삭제" on leads;
create policy "상담고객 삭제"
    on leads for delete
    using (has_permission(center_id, 'customer.lead.delete'));


-- ------------------------------------------------------------
-- messages — High. 대량 SMS/푸시 발송 이력. message.sms.*/message.push.* 권한 기준
-- (카탈로그 그대로 사용, 변경 없음 — 처음부터 permission 기반으로 설계됨).
-- ------------------------------------------------------------
alter table messages enable row level security;

drop policy if exists "발송이력 조회" on messages;
create policy "발송이력 조회"
    on messages for select
    using (
        has_permission(center_id, 'message.sms.view')
        or has_permission(center_id, 'message.push.view')
    );

drop policy if exists "발송이력 생성" on messages;
create policy "발송이력 생성"
    on messages for insert
    with check (
        (channel in ('sms', 'lms') and has_permission(center_id, 'message.sms.send'))
        or (channel = 'push' and has_permission(center_id, 'message.push.send'))
    );

drop policy if exists "발송이력 수정" on messages;
create policy "발송이력 수정"
    on messages for update
    using (
        (channel in ('sms', 'lms') and has_permission(center_id, 'message.sms.update'))
        or (channel = 'push' and has_permission(center_id, 'message.push.update'))
    )
    with check (
        (channel in ('sms', 'lms') and has_permission(center_id, 'message.sms.update'))
        or (channel = 'push' and has_permission(center_id, 'message.push.update'))
    );

drop policy if exists "발송이력 삭제" on messages;
create policy "발송이력 삭제"
    on messages for delete
    using (
        (channel in ('sms', 'lms') and has_permission(center_id, 'message.sms.delete'))
        or (channel = 'push' and has_permission(center_id, 'message.push.delete'))
    );

COMMIT;
