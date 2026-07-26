-- ============================================================
-- 룸(장소) 시스템
--
-- 하는 일:
--   1) rooms 테이블 (센터별 강습 공간)
--   2) classes.room_id (수업의 장소, 선택)
--   3) RLS: 센터 매니저만 관리/조회
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 룸 테이블 (classes보다 먼저 있어야 FK 걸림)
create table if not exists rooms (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id) on delete cascade,
    name        text not null,
    memo        text,
    sort_order  int not null default 0,
    created_at  timestamptz not null default now()
);

-- 수업에 장소 컬럼
alter table classes add column if not exists room_id uuid references rooms(id) on delete set null;

-- RLS
alter table rooms enable row level security;

drop policy if exists "룸 매니저 조회" on rooms;
create policy "룸 매니저 조회"
    on rooms for select
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());

drop policy if exists "룸 매니저 관리" on rooms;
create policy "룸 매니저 관리"
    on rooms for all
    using (center_id in (select my_managed_center_ids()) or is_platform_admin())
    with check (center_id in (select my_managed_center_ids()) or is_platform_admin());

-- 회원도 수업의 룸 이름을 볼 수 있게 (센터 상세 등) → 공개 조회 허용
drop policy if exists "룸 공개 조회" on rooms;
create policy "룸 공개 조회" on rooms for select using (true);


-- ============================================================
-- 확인
-- ============================================================
select 'rooms' as t, count(*) from rooms;


-- ============================================================
-- 완료!
--   관리자 모드 → 룸(장소) 관리 → 추가
--   수업 등록/수정 → 룸 선택
-- ============================================================
