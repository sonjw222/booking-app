-- ============================================================
-- "회원 메모" 신설 (customer.memo.view/create/update/delete 연결)
--
-- 배경: 카탈로그 원안(schema.sql:183-187)은 "본인이 작성한 메모만 수정/삭제, 스튜디오
-- 오너는 전체 수정/삭제 가능"이라는, 여러 스태프가 각자 메모를 남기고 서로 다른
-- 작성자 이력을 갖는 걸 전제로 한다. 기존에 있던 center_members.memo("특이사항")는
-- 계정당 하나뿐인 단일 텍스트 필드라 이 전제와 안 맞아서(누가 썼는지 이력이 없음),
-- 그 필드는 그대로 원래 용도(단일 자유 텍스트, 권한 무관)로 남겨두고, 이 기능은
-- 완전히 새 테이블로 만든다(사용자 확인, 2026-09-09) — schedule_memos(수업 메모)와
-- 정확히 같은 패턴, 같은 "다른 사람 메모는 오너만" 규칙(fix_schedule_memo_owner_only_
-- override.sql 참고 — has_permission()이 아니라 _is_owner_of_center()로 고정해야
-- 위임 가능한 권한이 되지 않는다).
--
-- 회원(본인)은 이 메모를 절대 볼 수 없어야 한다 — SELECT를 매니저 전용으로 좁힌다
-- (schedule_memos의 "센터 매니저 전체 공개" 예외와 달리, 이건 스케줄 조율용 정보가
-- 아니라 회원에 대한 내부 평가/기록이라 customer.memo.view 권한이 있는 사람만 봐야
-- 함이 맞다).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create table if not exists member_memos (
    id                uuid primary key default gen_random_uuid(),
    profile_id        uuid not null references profiles(id) on delete cascade,
    center_id         uuid not null references centers(id),
    author_account_id uuid not null references accounts(id),
    content           text not null,
    created_at        timestamptz not null default now()
);

comment on table member_memos is '회원에 대한 스태프 메모. 본인 작성분만 수정/삭제(오너는 전체) — 회원 본인은 절대 조회 불가.';

create index if not exists idx_member_memos_profile on member_memos (profile_id, created_at);

alter table member_memos enable row level security;

drop policy if exists "권한 보유자 회원메모 조회" on member_memos;
create policy "권한 보유자 회원메모 조회"
    on member_memos for select
    using (has_permission(center_id, 'customer.memo.view') or is_platform_admin());

drop policy if exists "본인 회원메모 작성" on member_memos;
create policy "본인 회원메모 작성"
    on member_memos for insert
    with check (
        author_account_id = my_account_id()
        and (has_permission(center_id, 'customer.memo.create') or is_platform_admin())
    );

drop policy if exists "본인 또는 오너 회원메모 수정" on member_memos;
create policy "본인 또는 오너 회원메모 수정"
    on member_memos for update
    using (
        (author_account_id = my_account_id() and (has_permission(center_id, 'customer.memo.update') or is_platform_admin()))
        or _is_owner_of_center(center_id)
        or is_platform_admin()
    )
    with check (
        (author_account_id = my_account_id() and (has_permission(center_id, 'customer.memo.update') or is_platform_admin()))
        or _is_owner_of_center(center_id)
        or is_platform_admin()
    );

drop policy if exists "본인 또는 오너 회원메모 삭제" on member_memos;
create policy "본인 또는 오너 회원메모 삭제"
    on member_memos for delete
    using (
        (author_account_id = my_account_id() and (has_permission(center_id, 'customer.memo.delete') or is_platform_admin()))
        or _is_owner_of_center(center_id)
        or is_platform_admin()
    );

-- RPC 없이 클라이언트가 직접 insert/update/delete한다 — schedule_memos와 동일한
-- 방식. author_account_id는 클라이언트가 값을 채워 보내지만 INSERT/UPDATE의
-- with check가 my_account_id()와 일치하는지 서버에서 다시 확인하므로 위조 불가능.

-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies where tablename = 'member_memos' order by cmd;
