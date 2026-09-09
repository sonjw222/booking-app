-- ============================================================
-- P2-31 — 수업 메모 기능 신설 (schedule.memo.create/update/delete 연결)
--
-- 배경: schedule_memos 테이블은 schema.sql부터 있었지만 이 기능을 쓸 화면/RLS가
-- 전혀 없어 schedule.memo.* 3개 키가 지금까지 완전히 죽어있었다. 이번엔
-- class_id(수업 상세페이지 메모) 경로만 만든다 — staff_schedule_id(기타일정) 경로는
-- 대응하는 화면 자체가 없어 범위 밖(별도 결정 사안, docs/TODO.md P3-5).
--
-- 이 RLS 설계는 이미 저장소에 있던 초안(proposed_rls_gap_batch_b.sql, 미실행)의
-- schedule_memos 부분을 기반으로 하되 두 가지를 고쳤다:
--   1) staff_schedule_id 관련 조건을 전부 제거(이번 배치 범위는 class_id뿐).
--   2) INSERT 정책에 author_account_id = my_account_id() 체크만 있고 실제
--      schedule.memo.create 권한 체크가 빠져있던 걸 발견 — 그 상태로는 그 수업이
--      속한 센터와 아무 관계 없는 계정도 자기 own_account_id로 메모를 끼워넣을 수
--      있었다(초안이라 미검증 상태였음). has_permission() 체크를 추가해 막았다.
--
-- 조회(SELECT)를 그 센터 매니저 전체에게 여는 것은 ACL-003과 다른, 의도된 예외다
-- (캘린더 메모는 스케줄 조율용 정보라 팀 공유가 자연스러움 — staff_schedules와 동일 근거).
-- 수정/삭제는 본인 작성분만, 단 has_permission()이 오너는 항상 true를 반환하므로
-- (add_personal_permissions.sql) 오너는 자동으로 전체 수정/삭제 권한을 갖는다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table schedule_memos enable row level security;

drop policy if exists "센터 스태프 일정메모 조회" on schedule_memos;
create policy "센터 스태프 일정메모 조회"
    on schedule_memos for select
    using (
        exists (
            select 1 from classes c
            where c.id = class_id and c.center_id in (select my_managed_center_ids())
        )
        or is_platform_admin()
    );

drop policy if exists "본인 일정메모 작성" on schedule_memos;
create policy "본인 일정메모 작성"
    on schedule_memos for insert
    with check (
        class_id is not null
        and staff_schedule_id is null
        and author_account_id = my_account_id()
        and exists (
            select 1 from classes c
            where c.id = class_id
              and (has_permission(c.center_id, 'schedule.memo.create') or is_platform_admin())
        )
    );

drop policy if exists "본인 또는 권한 보유자 일정메모 수정" on schedule_memos;
create policy "본인 또는 권한 보유자 일정메모 수정"
    on schedule_memos for update
    using (
        class_id is not null
        and (
            author_account_id = my_account_id()
            or exists (
                select 1 from classes c
                where c.id = class_id and (has_permission(c.center_id, 'schedule.memo.update') or is_platform_admin())
            )
        )
    )
    with check (
        class_id is not null
        and staff_schedule_id is null
        and (
            author_account_id = my_account_id()
            or exists (
                select 1 from classes c
                where c.id = class_id and (has_permission(c.center_id, 'schedule.memo.update') or is_platform_admin())
            )
        )
    );

drop policy if exists "본인 또는 권한 보유자 일정메모 삭제" on schedule_memos;
create policy "본인 또는 권한 보유자 일정메모 삭제"
    on schedule_memos for delete
    using (
        class_id is not null
        and (
            author_account_id = my_account_id()
            or exists (
                select 1 from classes c
                where c.id = class_id and (has_permission(c.center_id, 'schedule.memo.delete') or is_platform_admin())
            )
        )
    );

-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies where tablename = 'schedule_memos' order by cmd;
