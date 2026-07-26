-- ============================================================
-- 후기 관리 (센터 답변 + 관리자 삭제)
--
-- 하는 일:
--   1) center_reviews 에 답변 컬럼 추가
--   2) 매니저가 자기 센터 후기에 답변/수정
--   3) 악성 후기는 매니저가 삭제 가능
--
-- ⚠ fix_center_reviews.sql 을 먼저 실행했어야 해요.
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table center_reviews add column if not exists reply text;
alter table center_reviews add column if not exists replied_at timestamptz;
alter table center_reviews add column if not exists hidden boolean not null default false;

-- 매니저: 자기 센터 후기 수정(답변) 가능
drop policy if exists "센터후기 매니저 답변" on center_reviews;
create policy "센터후기 매니저 답변"
    on center_reviews for update
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());

-- 매니저: 자기 센터 후기 삭제 가능 (악성 후기)
drop policy if exists "센터후기 매니저 삭제" on center_reviews;
create policy "센터후기 매니저 삭제"
    on center_reviews for delete
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());


-- ============================================================
-- 답변 저장
-- ============================================================
create or replace function reply_review(p_review_id uuid, p_reply text)
returns void
language plpgsql
security definer
as $$
declare
    v_center uuid;
begin
    select center_id into v_center from center_reviews where id = p_review_id;
    if v_center is null then
        raise exception '후기를 찾을 수 없어요';
    end if;
    if not (v_center in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 후기에 답변할 권한이 없어요';
    end if;

    update center_reviews
       set reply = nullif(trim(p_reply), ''),
           replied_at = case when nullif(trim(p_reply), '') is null then null else now() end
     where id = p_review_id;
end;
$$;


-- ============================================================
-- 센터 후기 통계 (관리자 화면용)
-- ============================================================
create or replace function center_review_stats(p_center_id uuid)
returns table (
    total       bigint,
    avg_rating  numeric,
    no_reply    bigint
)
language sql
security definer
as $$
    select
        count(*),
        round(avg(rating)::numeric, 1),
        count(*) filter (where reply is null)
    from center_reviews
    where center_id = p_center_id
      and (p_center_id in (select my_managed_center_ids()) or is_platform_admin());
$$;


-- ============================================================
-- 완료!
--   관리자 모드 → 더보기 → 후기 관리
-- ============================================================
