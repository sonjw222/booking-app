-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN ⚠️
-- RLS Gap Batch B — 직원 운영 데이터
-- 대상: staff_schedules, schedule_memos, contract_templates, terms
-- 짝 파일: rollback_rls_gap_batch_b.sql
-- 재사용 헬퍼: my_account_id(), my_managed_center_ids(), has_permission(), is_platform_admin()
-- ============================================================


-- ------------------------------------------------------------
-- staff_schedules — 조회는 센터 전체(의도된 예외, 아래 설명), CUD는 본인+own 권한.
--
-- [정당화된 예외] SELECT가 my_managed_center_ids()만으로 열려 있는 것은 ACL-003과
-- 같은 실수가 아니라 의도된 설계다: 이 테이블은 "휴가/외부미팅" 같은 제목·시간뿐이고
-- (ACL-003처럼 다른 사람의 권한 grant/deny 같은 민감정보가 아님), 같은 센터 스태프끼리
-- 서로의 일정을 볼 수 있어야 스케줄 조율이 가능하다(캘린더 공유의 일반적 관행과 동일).
-- 반면 CUD(수정/삭제)는 본인 것만 + schedule.own.etc.* 권한까지 요구해 엄격하다.
-- ------------------------------------------------------------
alter table staff_schedules enable row level security;

drop policy if exists "센터 스태프 개인일정 조회" on staff_schedules;
create policy "센터 스태프 개인일정 조회"
    on staff_schedules for select
    using (center_id in (select my_managed_center_ids()));

drop policy if exists "본인 개인일정 생성" on staff_schedules;
create policy "본인 개인일정 생성"
    on staff_schedules for insert
    with check (account_id = my_account_id() and has_permission(center_id, 'schedule.own.etc.create'));
drop policy if exists "본인 개인일정 수정" on staff_schedules;
create policy "본인 개인일정 수정"
    on staff_schedules for update
    using (account_id = my_account_id() and has_permission(center_id, 'schedule.own.etc.update'))
    with check (account_id = my_account_id() and has_permission(center_id, 'schedule.own.etc.update'));
drop policy if exists "본인 개인일정 삭제" on staff_schedules;
create policy "본인 개인일정 삭제"
    on staff_schedules for delete
    using (account_id = my_account_id() and has_permission(center_id, 'schedule.own.etc.delete'));


-- ------------------------------------------------------------
-- schedule_memos — 조회는 연결된 수업/일정이 속한 센터 전체(위 staff_schedules와
-- 같은 이유로 정당화된 예외 — 캘린더 메모는 낮은 민감도의 조율용 정보).
-- 수정/삭제는 본인 작성분만(오너는 has_permission이 전권 처리).
-- ------------------------------------------------------------
alter table schedule_memos enable row level security;

drop policy if exists "센터 스태프 일정메모 조회" on schedule_memos;
create policy "센터 스태프 일정메모 조회"
    on schedule_memos for select
    using (
        exists (
            select 1 from classes c
            where c.id = class_id and c.center_id in (select my_managed_center_ids())
        )
        or exists (
            select 1 from staff_schedules s
            where s.id = staff_schedule_id and s.center_id in (select my_managed_center_ids())
        )
    );

drop policy if exists "본인 일정메모 작성" on schedule_memos;
create policy "본인 일정메모 작성"
    on schedule_memos for insert
    with check (author_account_id = my_account_id());

drop policy if exists "본인 또는 권한 보유자 일정메모 수정" on schedule_memos;
create policy "본인 또는 권한 보유자 일정메모 수정"
    on schedule_memos for update
    using (
        author_account_id = my_account_id()
        or exists (
            select 1 from classes c
            where c.id = class_id and has_permission(c.center_id, 'schedule.memo.update')
        )
        or exists (
            select 1 from staff_schedules s
            where s.id = staff_schedule_id and has_permission(s.center_id, 'schedule.memo.update')
        )
    );

drop policy if exists "본인 또는 권한 보유자 일정메모 삭제" on schedule_memos;
create policy "본인 또는 권한 보유자 일정메모 삭제"
    on schedule_memos for delete
    using (
        author_account_id = my_account_id()
        or exists (
            select 1 from classes c
            where c.id = class_id and has_permission(c.center_id, 'schedule.memo.delete')
        )
        or exists (
            select 1 from staff_schedules s
            where s.id = staff_schedule_id and has_permission(s.center_id, 'schedule.memo.delete')
        )
    );


-- ------------------------------------------------------------
-- contract_templates — contract.template.* 권한 기준(카탈로그 그대로, 변경 없음).
-- ------------------------------------------------------------
alter table contract_templates enable row level security;

drop policy if exists "계약서 템플릿 조회" on contract_templates;
create policy "계약서 템플릿 조회"
    on contract_templates for select
    using (has_permission(center_id, 'contract.template.view'));

drop policy if exists "계약서 템플릿 생성" on contract_templates;
create policy "계약서 템플릿 생성"
    on contract_templates for insert
    with check (has_permission(center_id, 'contract.template.write'));
drop policy if exists "계약서 템플릿 수정" on contract_templates;
create policy "계약서 템플릿 수정"
    on contract_templates for update
    using (has_permission(center_id, 'contract.template.write'))
    with check (has_permission(center_id, 'contract.template.write'));
drop policy if exists "계약서 템플릿 삭제" on contract_templates;
create policy "계약서 템플릿 삭제"
    on contract_templates for delete
    using (has_permission(center_id, 'contract.template.delete'));


-- ------------------------------------------------------------
-- terms — 조회 전체 허용(가입 전 노출 필요, PII 없음), 쓰기는 contract.terms.manage.
-- ------------------------------------------------------------
alter table terms enable row level security;

drop policy if exists "누구나 약관 조회" on terms;
create policy "누구나 약관 조회"
    on terms for select using (true);

drop policy if exists "약관 생성" on terms;
create policy "약관 생성"
    on terms for insert with check (has_permission(center_id, 'contract.terms.manage'));
drop policy if exists "약관 수정" on terms;
create policy "약관 수정"
    on terms for update
    using (has_permission(center_id, 'contract.terms.manage'))
    with check (has_permission(center_id, 'contract.terms.manage'));
drop policy if exists "약관 삭제" on terms;
create policy "약관 삭제"
    on terms for delete using (has_permission(center_id, 'contract.terms.manage'));
