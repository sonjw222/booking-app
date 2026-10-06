-- ============================================================
-- 내부 QA 센터를 공개/로그인 사용자 SELECT 경로에서도 숨기기(2026-10-04) — add_internal_qa_center_flag.sql 의 후속.
-- 선행: add_internal_qa_center_flag.sql 적용 후 실행(centers.is_internal, my_member_center_ids(), my_managed_center_ids(), is_platform_admin() 필요).
-- 문제: 기존 flag migration은 centers/classes/products와 공개 RPC만 막았다. 센터 id(또는 수업/상품 id)를 가진 다음 12개 테이블은 SELECT 정책이
--   true / 로그인 사용자 누구나(auth.role()='authenticated' / auth.uid() is not null)라 내부 QA 센터의 행도 무관한 사용자(rooms/center_reviews는 anon 포함)가 목록으로 읽을 수 있었다.
--   rooms, center_reviews, reviews(센터 대상), center_contacts, center_holidays, center_member_fields, center_settings, progress_categories, community_posts,
--   class_trainers, class_allowed_products(수업 경유), membership_schedule_rules(상품 경유).
--   (저장소 전수 조사: 정책 lineage를 파일 생성순으로 재구성해 trivial SELECT 정책이 남은 테이블 중 센터와 연결되는 것만 대상. center와 무관한 home_banners/service_categories/subscription_plans/permissions는 제외.)
-- 해결: SECURITY DEFINER helper 3개(center_rows_visible / class_rows_visible / product_rows_visible)로 "내부 센터 행은 그 센터의 회원/관리자/플랫폼 관리자에게만"을 한 곳에서 판단하고
--   각 정책의 기존 조건에 AND로 붙인다. 내부 센터가 아니거나 센터 연결이 없는 행(NULL)은 기존 동작 그대로(승인 대기/반려 센터의 공개 범위도 바꾸지 않는다 — 이번에는 internal만 숨긴다).
--   helper는 SECURITY DEFINER라 centers RLS를 다시 평가하지 않는다(RLS 재귀 없음). reviews는 target_center_id가 있는 센터 대상 행만 규칙을 따르고 사람 대상(target_center_id is null) 행은 그대로 보인다.
-- 정책 이름은 저장소 lineage 기준이다. 라이브 이름이 다르면 옛 정책이 OR로 남아 효과가 없으므로 반드시 verify_internal_qa_center_public_relations_20261004.sql 로 확인.
-- 이 세션에서는 production에 실행하지 않았습니다. rollback_fix_internal_qa_center_public_relations_20261004.sql 로 되돌립니다.
-- ============================================================
begin;

create or replace function public.center_rows_visible(p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select coalesce(
        p_center_id is null
        or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal)
        or p_center_id in (select public.my_member_center_ids())
        or p_center_id in (select public.my_managed_center_ids())
        or public.is_platform_admin(),
        false);
$$;

create or replace function public.class_rows_visible(p_class_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select public.center_rows_visible((select c.center_id from public.classes c where c.id = p_class_id));
$$;

create or replace function public.product_rows_visible(p_product_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select public.center_rows_visible((select p.center_id from public.products p where p.id = p_product_id));
$$;

revoke all on function public.center_rows_visible(uuid), public.class_rows_visible(uuid), public.product_rows_visible(uuid) from public;
grant execute on function public.center_rows_visible(uuid), public.class_rows_visible(uuid), public.product_rows_visible(uuid) to anon, authenticated, service_role;

drop policy if exists "룸 공개 조회" on public.rooms;
create policy "룸 공개 조회" on public.rooms for select using (public.center_rows_visible(center_id));
drop policy if exists "센터후기 공개 조회" on public.center_reviews;
create policy "센터후기 공개 조회" on public.center_reviews for select using (public.center_rows_visible(center_id));
drop policy if exists "로그인 사용자는 리뷰 조회 가능" on public.reviews;
create policy "로그인 사용자는 리뷰 조회 가능" on public.reviews for select using ((auth.role() = 'authenticated') and public.center_rows_visible(target_center_id));
drop policy if exists "후기 공개 조회" on public.reviews;   -- add_reviews_points.sql 의 using(true) 정책(fix_center_reviews.sql 이 지웠지만 라이브에 남아 있으면 제거)
drop policy if exists "상담채널 조회" on public.center_contacts;
create policy "상담채널 조회" on public.center_contacts for select using ((auth.role() = 'authenticated') and public.center_rows_visible(center_id));
drop policy if exists "로그인 사용자 휴무일 조회" on public.center_holidays;
create policy "로그인 사용자 휴무일 조회" on public.center_holidays for select using ((auth.role() = 'authenticated') and public.center_rows_visible(center_id));
drop policy if exists "센터 항목 조회" on public.center_member_fields;
create policy "센터 항목 조회" on public.center_member_fields for select using ((auth.role() = 'authenticated') and public.center_rows_visible(center_id));
drop policy if exists "설정 조회" on public.center_settings;
create policy "설정 조회" on public.center_settings for select using ((auth.uid() is not null) and public.center_rows_visible(center_id));
drop policy if exists "진도 카테고리 조회" on public.progress_categories;
create policy "진도 카테고리 조회" on public.progress_categories for select using ((auth.uid() is not null) and public.center_rows_visible(center_id));
drop policy if exists "로그인 사용자는 커뮤니티 게시글 조회 가능" on public.community_posts;
create policy "로그인 사용자는 커뮤니티 게시글 조회 가능" on public.community_posts for select using ((auth.role() = 'authenticated') and public.center_rows_visible(center_id));
drop policy if exists "수업 강사 조회" on public.class_trainers;
create policy "수업 강사 조회" on public.class_trainers for select using ((auth.role() = 'authenticated') and public.class_rows_visible(class_id));
drop policy if exists "수업수강권 조회" on public.class_allowed_products;
create policy "수업수강권 조회" on public.class_allowed_products for select using ((auth.uid() is not null) and public.class_rows_visible(class_id));
drop policy if exists "예약조건 조회" on public.membership_schedule_rules;
create policy "예약조건 조회" on public.membership_schedule_rules for select using ((auth.uid() is not null) and public.product_rows_visible(product_id));

commit;
