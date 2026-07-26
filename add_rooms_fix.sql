-- ============================================================
-- 룸 컬럼 보강 (memo/address/좌표 없던 문제 해결)
--
-- 기존에 rooms 테이블이 memo 없이 만들어졌을 수 있어서,
-- 필요한 컬럼을 개별적으로 추가합니다. (create table if not exists 는
-- 이미 테이블이 있으면 컬럼을 안 채워서 이 파일이 필요해요.)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 룸 테이블이 아예 없으면 생성
create table if not exists rooms (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id) on delete cascade,
    name        text not null,
    created_at  timestamptz not null default now()
);

-- 빠진 컬럼 개별 추가
alter table rooms add column if not exists memo text;
alter table rooms add column if not exists address text;
alter table rooms add column if not exists latitude double precision;
alter table rooms add column if not exists longitude double precision;
alter table rooms add column if not exists sort_order int not null default 0;

-- 수업 장소 컬럼
alter table classes add column if not exists room_id uuid references rooms(id) on delete set null;

-- RLS (이미 있으면 재생성)
alter table rooms enable row level security;

drop policy if exists "룸 매니저 관리" on rooms;
create policy "룸 매니저 관리"
    on rooms for all
    using (center_id in (select my_managed_center_ids()) or is_platform_admin())
    with check (center_id in (select my_managed_center_ids()) or is_platform_admin());

drop policy if exists "룸 공개 조회" on rooms;
create policy "룸 공개 조회" on rooms for select using (true);


-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns where table_name = 'rooms' order by ordinal_position;


-- ============================================================
-- 완료!
-- ============================================================
