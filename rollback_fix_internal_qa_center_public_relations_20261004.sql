-- fix_internal_qa_center_public_relations_20261004.sql 롤백: 12개 SELECT 정책을 직전 lineage 정의(trivial 조건)로 복원하고 helper 3개를 제거한다.
-- ⚠ 롤백하면 내부 QA 센터의 rooms/reviews/설정 등 행이 다시 무관한 사용자(rooms/center_reviews는 anon 포함)에게 목록으로 노출된다.
-- reviews의 "후기 공개 조회"(using true)는 이 migration이 지운 것이지만 fix_center_reviews.sql 이 이미 제거한 정책이므로 복원하지 않는다.
begin;

drop policy if exists "룸 공개 조회" on public.rooms;
create policy "룸 공개 조회" on public.rooms for select using (true);
drop policy if exists "센터후기 공개 조회" on public.center_reviews;
create policy "센터후기 공개 조회" on public.center_reviews for select using (true);
drop policy if exists "로그인 사용자는 리뷰 조회 가능" on public.reviews;
create policy "로그인 사용자는 리뷰 조회 가능" on public.reviews for select using (auth.role() = 'authenticated');
drop policy if exists "상담채널 조회" on public.center_contacts;
create policy "상담채널 조회" on public.center_contacts for select using (auth.role() = 'authenticated');
drop policy if exists "로그인 사용자 휴무일 조회" on public.center_holidays;
create policy "로그인 사용자 휴무일 조회" on public.center_holidays for select using (auth.role() = 'authenticated');
drop policy if exists "센터 항목 조회" on public.center_member_fields;
create policy "센터 항목 조회" on public.center_member_fields for select using (auth.role() = 'authenticated');
drop policy if exists "설정 조회" on public.center_settings;
create policy "설정 조회" on public.center_settings for select using (auth.uid() is not null);
drop policy if exists "진도 카테고리 조회" on public.progress_categories;
create policy "진도 카테고리 조회" on public.progress_categories for select using (auth.uid() is not null);
drop policy if exists "로그인 사용자는 커뮤니티 게시글 조회 가능" on public.community_posts;
create policy "로그인 사용자는 커뮤니티 게시글 조회 가능" on public.community_posts for select using (auth.role() = 'authenticated');
drop policy if exists "수업 강사 조회" on public.class_trainers;
create policy "수업 강사 조회" on public.class_trainers for select using (auth.role() = 'authenticated');
drop policy if exists "수업수강권 조회" on public.class_allowed_products;
create policy "수업수강권 조회" on public.class_allowed_products for select using (auth.uid() is not null);
drop policy if exists "예약조건 조회" on public.membership_schedule_rules;
create policy "예약조건 조회" on public.membership_schedule_rules for select using (auth.uid() is not null);

drop function if exists public.product_rows_visible(uuid);
drop function if exists public.class_rows_visible(uuid);
drop function if exists public.center_rows_visible(uuid);

commit;
