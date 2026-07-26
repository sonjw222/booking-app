-- ============================================================
-- 센터 공지사항 (매니저 작성 → 회원 열람)
--
-- 하는 일:
--   1) center_announcements 테이블 생성 (제목 + 내용 HTML + 사진)
--   2) 매니저는 자기 센터 공지 작성/수정/삭제
--   3) 회원은 자기가 관계된(수강권/예약 있는) 센터의 공지 열람
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- (헬퍼 함수 my_account_id / my_profile_ids / my_managed_center_ids /
--  is_platform_admin 이 이미 있어야 해요 — fix_staff_search.sql, add_platform_admin.sql)
-- ============================================================

-- ------------------------------------------------------------
-- 회원이 "관계된 센터" 목록 (수강권 또는 예약 이력이 있는 센터)
-- 공지/알림 열람 권한 판단에 사용
-- ------------------------------------------------------------
create or replace function my_related_center_ids()
returns setof uuid
language sql stable
security definer
set search_path = public
as $$
    select center_id from memberships where profile_id in (select my_profile_ids())
    union
    select c.center_id
      from reservations r
      join classes c on c.id = r.class_id
     where r.profile_id in (select my_profile_ids())
$$;


-- ------------------------------------------------------------
-- 공지사항 테이블
-- ------------------------------------------------------------
create table if not exists center_announcements (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id) on delete cascade,
    title       text not null,
    body        text not null default '',          -- 서식 포함 HTML
    photos      text[],                             -- 스토리지 경로 배열 (avatars 버킷 재사용)
    pinned      boolean not null default false,     -- 상단 고정
    created_by  uuid references accounts(id),       -- 작성한 매니저 계정
    created_at  timestamptz not null default now(),
    updated_at  timestamptz
);

create index if not exists idx_announcements_center on center_announcements(center_id, created_at desc);

alter table center_announcements enable row level security;

-- 회원: 자기가 관계된 센터의 공지 열람
drop policy if exists "공지 회원 열람" on center_announcements;
create policy "공지 회원 열람"
    on center_announcements for select
    using (
        center_id in (select my_related_center_ids())
        or center_id in (select my_managed_center_ids())
        or is_platform_admin()
    );

-- 매니저: 자기 센터 공지 작성
drop policy if exists "공지 매니저 작성" on center_announcements;
create policy "공지 매니저 작성"
    on center_announcements for insert
    with check (center_id in (select my_managed_center_ids()) or is_platform_admin());

-- 매니저: 자기 센터 공지 수정
drop policy if exists "공지 매니저 수정" on center_announcements;
create policy "공지 매니저 수정"
    on center_announcements for update
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());

-- 매니저: 자기 센터 공지 삭제
drop policy if exists "공지 매니저 삭제" on center_announcements;
create policy "공지 매니저 삭제"
    on center_announcements for delete
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());


-- ============================================================
-- 완료!
--   매니저 모드 → 더보기 → 공지사항
--   회원: 알림 탭에서 공지 확인 (add_notifications.sql 실행 후)
-- ============================================================
