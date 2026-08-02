-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN ⚠️
-- [2026-08-02] 이 파일은 5개 테이블을 한 번에 묶은 최초 초안이며, 이후 다음 2개로 분리되어
-- 대체됩니다(사용자 지적 — 검증되지 않은 테이블을 함께 적용하면 회귀 시 원인 분리가 어려움):
--   - proposed_rls_gap_batch_a1.sql — staff_salaries/leads/messages(통합 테스트 준비됨, 승인 대기)
--   - contracts/notification_logs — A2로 별도 조사 중(SQL 미작성, service_role GRANT 등 선결 필요)
-- 아래 내용은 역사적 기록으로 보존하며, 실제 적용은 위 분리된 파일만 사용하세요.
-- ------------------------------------------------------------
-- RLS Gap Batch A — 민감정보 최우선
-- 대상: staff_salaries, contracts, leads, messages, notification_logs
--
-- 이 파일은 add_rls_gap_tables_draft_proposed.sql(SEC-007/008)을 4개 독립 배치로
-- 나눈 것 중 첫 번째입니다. 각 배치는 단독으로 적용·검증·rollback 가능합니다.
-- 실행 전 반드시: 1) docs/21_RLS_Gap_Analysis.md 검토 2) 이 배치 전용 회귀 테스트 통과
-- 3) 사용자 명시적 승인 4) 스테이징 우선 검증. 짝 파일: rollback_rls_gap_batch_a.sql
--
-- 재사용 헬퍼(기존 함수, 신규 없음): my_account_id(), my_managed_center_ids(),
-- has_permission(center_id, permission_key), is_platform_admin()
--
-- [2026-08-02 정정] SEC-007 문서는 이 5개 테이블을 "RLS가 없거나 정책 0건"으로 분류했지만,
-- SEC-009 작업 중 개발(dev) Supabase에서 실제로 재확인한 결과 5개 테이블 전부 RLS는 이미
-- 활성화되어 있고(누가/언제 켰는지는 이 저장소의 SQL 이력에 없음 — 대시보드에서 직접
-- 조작된 것으로 추정) 정책만 0건인 상태였다(현재는 오너 포함 아무도 접근 불가 — 완전 차단,
-- 원래 우려했던 "누구나 접근 가능"보다는 안전한 상태). 아래 `enable row level security`는
-- dev에서는 이미 켜져 있어 사실상 no-op이지만, **운영(production) Supabase는 별도로 확인되지
-- 않았으므로**(이 세션에서 접근 권한 없음) 그대로 남겨둔다 — 운영에서 정말 꺼져 있는 상태일
-- 수도 있어 멱등하게 두는 것이 안전하다. 실행 승인 전 운영 Supabase의 실제 상태도 반드시
-- 별도 확인할 것.
-- ============================================================


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

-- DELETE: 카탈로그에 salary 전용 delete 권한 키가 없음 — other.update 권한으로 대체(초안 단계 한계, TODO P2-11 참고).
drop policy if exists "급여 삭제" on staff_salaries;
create policy "급여 삭제"
    on staff_salaries for delete
    using (has_permission(center_id, 'facility.salary.other.update'));


-- ------------------------------------------------------------
-- contracts — Critical. 서명 이미지 포함. 서명 후에는 불변 원칙.
-- ------------------------------------------------------------
alter table contracts enable row level security;

drop policy if exists "본인 또는 권한 보유 스태프 계약서 조회" on contracts;
create policy "본인 또는 권한 보유 스태프 계약서 조회"
    on contracts for select
    using (
        profile_id in (select id from profiles where account_id = my_account_id())
        or has_permission(center_id, 'contract.list.view')
        or is_platform_admin()
    );

-- INSERT: 임시로 권한 기반 허용. 실제 적용 전 서명 발급을 RPC(서버 검증)로 전환하는
-- 방안을 반드시 재검토할 것 — TODO P2-11에 이미 기록됨.
drop policy if exists "권한 보유 스태프 계약서 생성" on contracts;
create policy "권한 보유 스태프 계약서 생성"
    on contracts for insert
    with check (has_permission(center_id, 'contract.list.view'));

-- UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부.
-- 서명 완료된 계약서는 법적 증빙이므로 클라이언트에서 직접 수정/삭제할 수 없어야 함.
-- 상태 변경(예: 취소)이 필요하면 반드시 RPC(security definer)로 별도 구현할 것.


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


-- ------------------------------------------------------------
-- notification_logs — Medium(정산 데이터라 이 배치에 포함). 쓰기는 서버(트리거) 전용.
--
-- [ACL-003 재검증 이후 강화] 원안은 SELECT를 my_managed_center_ids()만으로 허용했으나
-- ("센터 소속이면 누구나") 이는 ACL-003에서 발견한 것과 동일한 과다 권한 패턴이다.
-- 정산 관련 로그이므로 message.sms.view/message.push.view 권한 보유자로 좁힌다
-- (messages 테이블의 조회 권한과 topically 일치 — 이 로그도 발송 관련 정산 기록이므로).
-- ------------------------------------------------------------
alter table notification_logs enable row level security;

drop policy if exists "센터 스태프 알림발송기록 조회" on notification_logs;
create policy "권한 보유 스태프 알림발송기록 조회"
    on notification_logs for select
    using (
        has_permission(center_id, 'message.sms.view')
        or has_permission(center_id, 'message.push.view')
        or is_platform_admin()
    );
-- INSERT/UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부 (서버 트리거 전용)
