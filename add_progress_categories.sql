-- ============================================================
-- 진도표 1단계: 기술 목록 관리
--
-- 하는 일:
--   1) 진도표 관리 권한(customer.progress) 카탈로그에 추가
--   2) progress_categories / progress_records RLS 정책
--      (지금은 RLS가 꺼져 있어 아무나 남의 센터 진도를 볼 수 있음 → 격리)
--
-- DB 재생성 불필요. 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================


-- ------------------------------------------------------------
-- [1] 진도표 관리 권한
-- ------------------------------------------------------------
insert into permissions (key, category, parent_key, label, description, sort_order)
values
    ('customer.progress', 'customer', null, '진도표 관리',
     '회원 진도표의 기술 목록을 편집하고 진도를 기록할 수 있습니다.', 50)
on conflict (key) do nothing;


-- ------------------------------------------------------------
-- [2] progress_categories 정책 (기술 목록)
-- ------------------------------------------------------------
alter table progress_categories enable row level security;

drop policy if exists "진도 카테고리 조회" on progress_categories;
create policy "진도 카테고리 조회"
    on progress_categories for select
    using (auth.uid() is not null);

drop policy if exists "진도 카테고리 생성" on progress_categories;
create policy "진도 카테고리 생성"
    on progress_categories for insert
    with check (has_permission(center_id, 'customer.progress'));

drop policy if exists "진도 카테고리 수정" on progress_categories;
create policy "진도 카테고리 수정"
    on progress_categories for update
    using (has_permission(center_id, 'customer.progress'))
    with check (has_permission(center_id, 'customer.progress'));

drop policy if exists "진도 카테고리 삭제" on progress_categories;
create policy "진도 카테고리 삭제"
    on progress_categories for delete
    using (has_permission(center_id, 'customer.progress'));


-- ------------------------------------------------------------
-- [3] progress_records 정책 (진도 기록 — 2단계에서 화면 붙임)
-- ------------------------------------------------------------
alter table progress_records enable row level security;

drop policy if exists "진도 기록 조회" on progress_records;
create policy "진도 기록 조회"
    on progress_records for select
    using (
        profile_id in (select my_profile_ids())
        or category_id in (
            select id from progress_categories
            where has_permission(center_id, 'customer.progress')
        )
    );

drop policy if exists "진도 기록 생성" on progress_records;
create policy "진도 기록 생성"
    on progress_records for insert
    with check (
        category_id in (
            select id from progress_categories
            where has_permission(center_id, 'customer.progress')
        )
    );

drop policy if exists "진도 기록 삭제" on progress_records;
create policy "진도 기록 삭제"
    on progress_records for delete
    using (
        category_id in (
            select id from progress_categories
            where has_permission(center_id, 'customer.progress')
        )
    );


-- ============================================================
-- 확인
-- ============================================================
select tablename, count(*) as 정책수
from pg_policies
where tablename in ('progress_categories', 'progress_records')
group by tablename;


-- ============================================================
-- 완료!
--   → 오너 계정 → 매니저 대시보드 → "진도표 기술 목록"
--   → 대분류(점프) 추가 → 그 안에 세부기술(왈츠점프) 추가
--
--   ※ 강사가 편집하게 하려면 [역할별/개인 권한]에서
--     '진도표 관리'(customer.progress)를 켜주세요. 오너는 항상 가능.
-- ============================================================
