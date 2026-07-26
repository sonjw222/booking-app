-- ============================================================
-- 운영자 설정: 종목 목록 + 홈 배너 + 센터 종목(다중)
--
-- 하는 일:
--   1) service_categories 테이블 (운영자가 종목 추가/삭제)
--   2) home_banners 테이블 (운영자가 홈 배너 관리, 순서대로 회전)
--   3) centers.categories 를 배열(text[])로 (센터가 여러 종목 가능)
--   4) 조회는 공개, 쓰기는 운영자(is_platform_admin)만
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 센터 종목: 배열로 (기존 category 컬럼이 있으면 옮기고 삭제)
alter table centers add column if not exists categories text[] not null default '{}';
do $$
begin
  if exists (select 1 from information_schema.columns where table_name='centers' and column_name='category') then
    update centers set categories = array[category] where category is not null and (categories = '{}' or categories is null);
    alter table centers drop column category;
  end if;
end $$;

-- 종목 테이블
create table if not exists service_categories (
    id          uuid primary key default gen_random_uuid(),
    label       text not null unique,
    emoji       text,
    sort_order  int not null default 0,
    created_at  timestamptz not null default now()
);

-- 배너 테이블
create table if not exists home_banners (
    id          uuid primary key default gen_random_uuid(),
    title       text not null,
    subtitle    text,
    emoji       text,
    link_url    text,
    is_active   boolean not null default true,
    sort_order  int not null default 0,
    created_at  timestamptz not null default now()
);

-- RLS
alter table service_categories enable row level security;
alter table home_banners enable row level security;

drop policy if exists "종목 공개 조회" on service_categories;
create policy "종목 공개 조회" on service_categories for select using (true);
drop policy if exists "종목 운영자 관리" on service_categories;
create policy "종목 운영자 관리" on service_categories for all
    using (is_platform_admin()) with check (is_platform_admin());

drop policy if exists "배너 공개 조회" on home_banners;
create policy "배너 공개 조회" on home_banners for select using (true);
drop policy if exists "배너 운영자 관리" on home_banners;
create policy "배너 운영자 관리" on home_banners for all
    using (is_platform_admin()) with check (is_platform_admin());

-- 기본 종목 몇 개 넣기 (이미 있으면 무시)
insert into service_categories (label, emoji, sort_order) values
    ('피겨스케이팅', '⛸️', 1),
    ('필라테스', '🧘', 2),
    ('발레', '🩰', 3),
    ('리듬체조', '🤸', 4),
    ('요가', '🧎', 5),
    ('복싱', '🥊', 6),
    ('수영', '🏊', 7),
    ('골프', '⛳', 8)
on conflict (label) do nothing;

-- 기본 배너 (첫 등록 혜택)
insert into home_banners (title, subtitle, emoji, sort_order) values
    ('첫 등록이면 수강료 5,000원 쿠폰', '신규 회원 웰컴 혜택 · 필라테스 · 발레 · 스케이팅', '🎁', 1)
on conflict do nothing;


-- ============================================================
-- 확인
-- ============================================================
select 'categories' as t, count(*) from service_categories
union all select 'banners', count(*) from home_banners;


-- ============================================================
-- 완료!
--   운영자: 마이페이지 → 운영자 설정 → 종목 관리 / 배너 관리
--   매니저: 센터 정보 → 종목 여러 개 선택
-- ============================================================
