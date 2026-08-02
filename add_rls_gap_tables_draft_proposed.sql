-- ============================================================
-- ⚠️ 초안(DRAFT) / 제안(PROPOSED) — 실행 금지 ⚠️
--
-- [2026-08-01 갱신] 이 단일 파일은 더 이상 "실제 적용용"으로 쓰지 않습니다.
-- 후속 배치에서는 아래 4개 독립 배치 파일(+짝 rollback 파일)을 대신 사용하세요.
-- 각 배치는 단독으로 적용·검증·rollback 가능하며, ACL-003 재검증에서 발견한
-- "센터 소속 = 전체 권한" 과다 권한 패턴을 일부 정책에서 수정해 반영했습니다
-- (이 파일과 내용이 달라진 부분이 있다는 뜻 — 아래 배치 파일이 최신입니다).
--   - proposed_rls_gap_batch_a.sql / rollback_rls_gap_batch_a.sql (민감정보 최우선)
--   - proposed_rls_gap_batch_b.sql / rollback_rls_gap_batch_b.sql (직원 운영 데이터)
--   - proposed_rls_gap_batch_c.sql / rollback_rls_gap_batch_c.sql (회원·시설 기능)
--   - proposed_rls_gap_batch_d.sql / rollback_rls_gap_batch_d.sql (미구현·레거시 후보)
-- 이 파일은 원래 조사·설계 시점의 기록으로 보존합니다.
--
-- 이 파일은 SEC-007/SEC-008 조사 결과로 작성된 "설계 산출물"입니다.
-- Access Control + RLS Design Batch에서는 이 SQL을 운영 Supabase에
-- 절대 실행하지 않습니다. 아래를 모두 만족한 뒤 별도 승인/배치에서만 실행하세요.
--
--   1) docs/21_RLS_Gap_Analysis.md의 우선순위/영향도 검토 완료
--   2) 각 정책에 대한 회귀 테스트(아래 각 섹션의 "테스트 시나리오") 작성 및 통과
--   3) 사용자(오너)의 명시적 실행 승인
--   4) 실행 전 반드시 스테이징/로컬 Supabase 프로젝트에서 먼저 검증
--
-- 17개 테이블 전부 현재 app/lib 코드에서 참조되지 않는(미사용) 테이블입니다.
-- 즉 이 정책을 적용해도 기존 기능은 깨지지 않습니다 — 다만 그만큼 "안전하니
-- 서둘러 실행해도 된다"는 뜻이 아니라, 반대로 검증 없이 실행해 실수가 나도
-- 당장 드러나지 않는다는 뜻이므로 더 신중해야 합니다.
--
-- 재사용 헬퍼(이미 존재, 새로 만들지 않음): my_account_id(), my_managed_center_ids(),
-- has_permission(center_id, permission_key), is_platform_admin()
-- ============================================================


-- ------------------------------------------------------------
-- 1. change_logs — 감사로그. 조회만 허용, 쓰기는 서버(트리거/RPC) 전용.
-- ------------------------------------------------------------
alter table change_logs enable row level security;

drop policy if exists "센터 스태프 변경이력 조회" on change_logs;
create policy "센터 스태프 변경이력 조회"
    on change_logs for select
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());
-- INSERT/UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부 (서버 함수는 security definer로 우회)


-- ------------------------------------------------------------
-- 2. class_types — PII 없음. 로그인 사용자 조회, 센터 스태프 쓰기.
-- ------------------------------------------------------------
alter table class_types enable row level security;

drop policy if exists "로그인 사용자 수업구분 조회" on class_types;
create policy "로그인 사용자 수업구분 조회"
    on class_types for select using (auth.role() = 'authenticated');

drop policy if exists "센터 스태프 수업구분 관리" on class_types;
drop policy if exists "센터 스태프 수업구분 생성" on class_types;
create policy "센터 스태프 수업구분 생성"
    on class_types for insert
    with check (center_id in (select my_managed_center_ids()));
create policy "센터 스태프 수업구분 수정"
    on class_types for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));
create policy "센터 스태프 수업구분 삭제"
    on class_types for delete
    using (center_id in (select my_managed_center_ids()));


-- ------------------------------------------------------------
-- 3. community_comments — 작성자 본인만 쓰기/수정/삭제.
--    (부모 community_posts도 write 정책이 없어 별도 후속 이슈 필요 — TODO에 기록됨)
-- ------------------------------------------------------------
alter table community_comments enable row level security;

drop policy if exists "로그인 사용자 댓글 조회" on community_comments;
create policy "로그인 사용자 댓글 조회"
    on community_comments for select using (auth.role() = 'authenticated');

drop policy if exists "본인 댓글 작성" on community_comments;
create policy "본인 댓글 작성"
    on community_comments for insert
    with check (author_account_id = my_account_id());

drop policy if exists "본인 댓글 수정" on community_comments;
create policy "본인 댓글 수정"
    on community_comments for update
    using (author_account_id = my_account_id())
    with check (author_account_id = my_account_id());

drop policy if exists "본인 댓글 삭제" on community_comments;
create policy "본인 댓글 삭제"
    on community_comments for delete
    using (author_account_id = my_account_id());


-- ------------------------------------------------------------
-- 4. competitions — 전역 공개 정보. 조회는 전체 허용, 쓰기는 platform admin만.
-- ------------------------------------------------------------
alter table competitions enable row level security;

drop policy if exists "누구나 대회정보 조회" on competitions;
create policy "누구나 대회정보 조회"
    on competitions for select using (true);

drop policy if exists "플랫폼 운영자 대회정보 관리" on competitions;
create policy "플랫폼 운영자 대회정보 관리"
    on competitions for all
    using (is_platform_admin())
    with check (is_platform_admin());


-- ------------------------------------------------------------
-- 5. contract_templates — contract.template.* 권한 기준.
-- ------------------------------------------------------------
alter table contract_templates enable row level security;

drop policy if exists "계약서 템플릿 조회" on contract_templates;
create policy "계약서 템플릿 조회"
    on contract_templates for select
    using (has_permission(center_id, 'contract.template.view'));

drop policy if exists "계약서 템플릿 생성/수정" on contract_templates;
create policy "계약서 템플릿 생성"
    on contract_templates for insert
    with check (has_permission(center_id, 'contract.template.write'));
create policy "계약서 템플릿 수정"
    on contract_templates for update
    using (has_permission(center_id, 'contract.template.write'))
    with check (has_permission(center_id, 'contract.template.write'));
create policy "계약서 템플릿 삭제"
    on contract_templates for delete
    using (has_permission(center_id, 'contract.template.delete'));


-- ------------------------------------------------------------
-- 6. contracts — 최우선(Critical). 서명 이미지 포함. 서명 후에는 불변 원칙.
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

-- INSERT: 임시로 권한 기반 허용. 실제 적용 전, 서명 발급을 RPC(서버 검증)로
-- 전환하는 방안을 반드시 재검토할 것(아래 주석 참고).
drop policy if exists "권한 보유 스태프 계약서 생성" on contracts;
create policy "권한 보유 스태프 계약서 생성"
    on contracts for insert
    with check (has_permission(center_id, 'contract.list.view'));

-- UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부.
--   서명 완료된 계약서는 법적 증빙이므로 클라이언트에서 직접 수정/삭제할 수 없어야 함.
--   상태 변경(예: 취소)이 필요하면 반드시 RPC(security definer)로 별도 구현할 것.


-- ------------------------------------------------------------
-- 7. leads — customer.lead.* 권한 기준.
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
-- 8. lockers / 9. locker_assignments
-- ------------------------------------------------------------
alter table lockers enable row level security;

drop policy if exists "로그인 사용자 락커 조회" on lockers;
create policy "로그인 사용자 락커 조회"
    on lockers for select using (auth.role() = 'authenticated');

drop policy if exists "센터 스태프 락커 관리" on lockers;
create policy "센터 스태프 락커 생성"
    on lockers for insert with check (center_id in (select my_managed_center_ids()));
create policy "센터 스태프 락커 수정"
    on lockers for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));
create policy "센터 스태프 락커 삭제"
    on lockers for delete using (center_id in (select my_managed_center_ids()));

alter table locker_assignments enable row level security;

drop policy if exists "본인 또는 센터 스태프 락커배정 조회" on locker_assignments;
create policy "본인 또는 센터 스태프 락커배정 조회"
    on locker_assignments for select
    using (
        profile_id in (select id from profiles where account_id = my_account_id())
        or locker_id in (select id from lockers where center_id in (select my_managed_center_ids()))
    );

drop policy if exists "센터 스태프 락커배정 관리" on locker_assignments;
create policy "센터 스태프 락커배정 생성"
    on locker_assignments for insert
    with check (locker_id in (select id from lockers where center_id in (select my_managed_center_ids())));
create policy "센터 스태프 락커배정 수정"
    on locker_assignments for update
    using (locker_id in (select id from lockers where center_id in (select my_managed_center_ids())))
    with check (locker_id in (select id from lockers where center_id in (select my_managed_center_ids())));
create policy "센터 스태프 락커배정 삭제"
    on locker_assignments for delete
    using (locker_id in (select id from lockers where center_id in (select my_managed_center_ids())));


-- ------------------------------------------------------------
-- 10. membership_transfers — 이력은 불변. 발급은 RPC 권장(이번 정책은 조회만).
-- ------------------------------------------------------------
alter table membership_transfers enable row level security;

drop policy if exists "당사자 또는 권한 보유 스태프 양도이력 조회" on membership_transfers;
create policy "당사자 또는 권한 보유 스태프 양도이력 조회"
    on membership_transfers for select
    using (
        from_profile_id in (select id from profiles where account_id = my_account_id())
        or to_profile_id in (select id from profiles where account_id = my_account_id())
        or exists (
            select 1 from memberships m
            where m.id = membership_id
              and has_permission(m.center_id, 'customer.member.pass_detail')
        )
    );
-- INSERT/UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부.
--   양도는 잔여횟수 원자적 갱신이 필요하므로 반드시 RPC(security definer)로 처리할 것.


-- ------------------------------------------------------------
-- 11. messages — 대량 SMS/푸시 발송 이력. message.sms.*/message.push.* 권한 기준.
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
-- 12. notification_logs — 정산용 조회만. 쓰기는 서버(트리거) 전용.
-- ------------------------------------------------------------
alter table notification_logs enable row level security;

drop policy if exists "센터 스태프 알림발송기록 조회" on notification_logs;
create policy "센터 스태프 알림발송기록 조회"
    on notification_logs for select
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());
-- INSERT/UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부


-- ------------------------------------------------------------
-- 13. popup_notices — 조회는 전체 허용(공지 성격), 쓰기는 스코프별 분리.
-- ------------------------------------------------------------
alter table popup_notices enable row level security;

drop policy if exists "누구나 팝업공지 조회" on popup_notices;
create policy "누구나 팝업공지 조회"
    on popup_notices for select using (true);

drop policy if exists "팝업공지 관리" on popup_notices;
create policy "팝업공지 생성"
    on popup_notices for insert
    with check (
        (center_id is null and is_platform_admin())
        or (center_id is not null and center_id in (select my_managed_center_ids()))
    );
create policy "팝업공지 수정"
    on popup_notices for update
    using (
        (center_id is null and is_platform_admin())
        or (center_id is not null and center_id in (select my_managed_center_ids()))
    )
    with check (
        (center_id is null and is_platform_admin())
        or (center_id is not null and center_id in (select my_managed_center_ids()))
    );
create policy "팝업공지 삭제"
    on popup_notices for delete
    using (
        (center_id is null and is_platform_admin())
        or (center_id is not null and center_id in (select my_managed_center_ids()))
    );


-- ------------------------------------------------------------
-- 14. schedule_memos — 본인 작성분만 수정/삭제(오너는 has_permission이 전권 처리).
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
-- 15. staff_salaries — Critical. own/other 권한 완전 분리.
-- ------------------------------------------------------------
alter table staff_salaries enable row level security;

drop policy if exists "급여 조회 (본인/타인 권한 분리)" on staff_salaries;
create policy "급여 조회 (본인/타인 권한 분리)"
    on staff_salaries for select
    using (
        (account_id = my_account_id() and has_permission(center_id, 'facility.salary.own.view'))
        or (account_id != my_account_id() and has_permission(center_id, 'facility.salary.other.view'))
    );

drop policy if exists "급여 등록/수정 (본인/타인 권한 분리)" on staff_salaries;
create policy "급여 등록 (본인/타인 권한 분리)"
    on staff_salaries for insert
    with check (
        (account_id = my_account_id() and has_permission(center_id, 'facility.salary.own.update'))
        or (account_id != my_account_id() and has_permission(center_id, 'facility.salary.other.update'))
    );
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

-- DELETE: 카탈로그에 salary 전용 delete 권한 키가 없음 — other.update 권한으로 대체.
--   후속 배치에서 facility.salary.setting(급여 설정 권한)을 delete에 쓸지 재검토 필요.
drop policy if exists "급여 삭제" on staff_salaries;
create policy "급여 삭제"
    on staff_salaries for delete
    using (has_permission(center_id, 'facility.salary.other.update'));


-- ------------------------------------------------------------
-- 16. staff_schedules — 조회는 센터 전체, CUD는 본인+own 권한.
-- ------------------------------------------------------------
alter table staff_schedules enable row level security;

drop policy if exists "센터 스태프 개인일정 조회" on staff_schedules;
create policy "센터 스태프 개인일정 조회"
    on staff_schedules for select
    using (center_id in (select my_managed_center_ids()));

drop policy if exists "본인 개인일정 관리" on staff_schedules;
create policy "본인 개인일정 생성"
    on staff_schedules for insert
    with check (account_id = my_account_id() and has_permission(center_id, 'schedule.own.etc.create'));
create policy "본인 개인일정 수정"
    on staff_schedules for update
    using (account_id = my_account_id() and has_permission(center_id, 'schedule.own.etc.update'))
    with check (account_id = my_account_id() and has_permission(center_id, 'schedule.own.etc.update'));
create policy "본인 개인일정 삭제"
    on staff_schedules for delete
    using (account_id = my_account_id() and has_permission(center_id, 'schedule.own.etc.delete'));


-- ------------------------------------------------------------
-- 17. terms — 조회 전체 허용(가입 전 노출 필요), 쓰기는 contract.terms.manage.
-- ------------------------------------------------------------
alter table terms enable row level security;

drop policy if exists "누구나 약관 조회" on terms;
create policy "누구나 약관 조회"
    on terms for select using (true);

drop policy if exists "약관 관리" on terms;
create policy "약관 생성"
    on terms for insert with check (has_permission(center_id, 'contract.terms.manage'));
create policy "약관 수정"
    on terms for update
    using (has_permission(center_id, 'contract.terms.manage'))
    with check (has_permission(center_id, 'contract.terms.manage'));
create policy "약관 삭제"
    on terms for delete using (has_permission(center_id, 'contract.terms.manage'));


-- ============================================================
-- chat_messages는 이 파일에 포함하지 않음 — DB-001 결론에 따라
-- "정책 추가"가 아니라 "삭제 후보"이므로 별도 승인 후 DROP 마이그레이션으로 처리.
-- ============================================================
