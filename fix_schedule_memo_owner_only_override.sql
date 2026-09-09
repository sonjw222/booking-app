-- ============================================================
-- 수업 메모(schedule_memos) — "다른 사람 메모" 수정/삭제는 오너 전용으로 고정
--
-- 배경: add_schedule_memo_feature.sql의 수정/삭제 정책에서 "다른 작성자" 분기가
-- has_permission(center_id, 'schedule.memo.update'/'delete')를 썼다. 그런데
-- has_permission()은 그 키를 role_permissions에 명시적으로 부여받은 어떤 역할이든
-- true를 반환한다 — 오너뿐 아니라 오너가 실수로(또는 의도적으로) 이 키를 일반
-- 강사/매니저 역할에 부여하면, 그 스태프도 다른 사람이 쓴 메모를 전부 수정·삭제할
-- 수 있게 된다. 카탈로그 라벨 자체가 "본인이 작성한 메모를 수정할 수 있습니다.
-- (단, 스튜디오 오너는 모든 메모를 수정할 수 있습니다.)"라고 명시하므로, "다른 사람
-- 메모" 예외는 위임 가능한 권한이 아니라 오너 지위에 하드코딩돼야 한다(사용자 확인,
-- 2026-09-09).
--
-- 수정: "다른 작성자" 분기만 _is_owner_of_center(center_id)로 교체한다. "본인 작성분"
-- 분기(author_account_id = my_account_id() and has_permission(...))는 그대로 둔다 —
-- 본인 메모를 고치는 데도 여전히 schedule.memo.update/delete 키 자체는 필요하다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

drop policy if exists "본인 또는 권한 보유자 일정메모 수정" on schedule_memos;
create policy "본인 또는 오너 일정메모 수정"
    on schedule_memos for update
    using (
        class_id is not null
        and (
            (author_account_id = my_account_id() and exists (
                select 1 from classes c
                where c.id = class_id and (has_permission(c.center_id, 'schedule.memo.update') or is_platform_admin())
            ))
            or exists (
                select 1 from classes c
                where c.id = class_id and (_is_owner_of_center(c.center_id) or is_platform_admin())
            )
        )
    )
    with check (
        class_id is not null
        and staff_schedule_id is null
        and (
            (author_account_id = my_account_id() and exists (
                select 1 from classes c
                where c.id = class_id and (has_permission(c.center_id, 'schedule.memo.update') or is_platform_admin())
            ))
            or exists (
                select 1 from classes c
                where c.id = class_id and (_is_owner_of_center(c.center_id) or is_platform_admin())
            )
        )
    );

drop policy if exists "본인 또는 권한 보유자 일정메모 삭제" on schedule_memos;
create policy "본인 또는 오너 일정메모 삭제"
    on schedule_memos for delete
    using (
        class_id is not null
        and (
            (author_account_id = my_account_id() and exists (
                select 1 from classes c
                where c.id = class_id and (has_permission(c.center_id, 'schedule.memo.delete') or is_platform_admin())
            ))
            or exists (
                select 1 from classes c
                where c.id = class_id and (_is_owner_of_center(c.center_id) or is_platform_admin())
            )
        )
    );

-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies where tablename = 'schedule_memos' order by cmd;
