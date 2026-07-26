-- ============================================================
-- ⚠ 센터 후기 테이블 분리 (오류 수정)
--
-- 원인:
--   기존 schema.sql 에 이미 다른 용도의 reviews 테이블이 있었습니다
--   (센터-회원 상호 평점용, reviewer_account_id 필수).
--   제가 같은 이름을 쓰는 바람에 후기 작성 시
--   "null value in column reviewer_account_id" 오류가 났습니다.
--
-- 해결:
--   센터 후기는 center_reviews 라는 별도 테이블로 분리합니다.
--   기존 reviews 테이블은 건드리지 않습니다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 잘못 만들어졌을 수 있는 정책 정리
drop policy if exists "후기 공개 조회" on reviews;
drop policy if exists "후기 본인 작성" on reviews;
drop policy if exists "후기 본인 수정" on reviews;
drop policy if exists "후기 본인 삭제" on reviews;

-- 센터 후기 (신규 테이블)
create table if not exists center_reviews (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id) on delete cascade,
    profile_id  uuid not null references profiles(id) on delete cascade,
    rating      int  not null check (rating between 1 and 5),
    content     text not null,
    photos      text[],                                  -- 후기 사진 (storage 경로, 여러 장)
    created_at  timestamptz not null default now(),
    unique (center_id, profile_id)
);

alter table center_reviews add column if not exists photos text[];

create index if not exists idx_center_reviews on center_reviews(center_id, created_at desc);

alter table center_reviews enable row level security;

drop policy if exists "센터후기 공개 조회" on center_reviews;
create policy "센터후기 공개 조회" on center_reviews for select using (true);

drop policy if exists "센터후기 본인 작성" on center_reviews;
create policy "센터후기 본인 작성" on center_reviews for insert
    with check (profile_id in (select my_profile_ids()));

drop policy if exists "센터후기 본인 수정" on center_reviews;
create policy "센터후기 본인 수정" on center_reviews for update
    using (profile_id in (select my_profile_ids()));

drop policy if exists "센터후기 본인 삭제" on center_reviews;
create policy "센터후기 본인 삭제" on center_reviews for delete
    using (profile_id in (select my_profile_ids()));


-- ============================================================
-- 후기 작성 + 포인트 적립 (center_reviews 기준으로 재작성)
--   작성 자격: 이 센터 수강권을 "현재 보유" 또는 "구매한 이력"이 있는 회원
--             (환불·만료된 것도 구매 이력으로 인정)
-- ============================================================

create or replace function write_review(
    p_center_id uuid,
    p_profile_id uuid,
    p_rating int,
    p_content text,
    p_photos text[] default null
)
returns json
language plpgsql
security definer
as $$
declare
    v_has_pass int;
    v_point    int;
    v_exists   int;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 프로필로만 후기를 쓸 수 있어요';
    end if;

    -- 구매 이력 확인 (보유 중 + 과거 구매 모두 인정)
    select count(*) into v_has_pass
    from memberships
    where profile_id = p_profile_id and center_id = p_center_id;

    -- 주문 이력도 인정 (아직 발급 전이거나 발급 기록이 없는 경우 대비)
    if v_has_pass = 0 then
        select count(*) into v_has_pass
        from orders
        where profile_id = p_profile_id
          and center_id = p_center_id
          and status in ('paid', 'done');
    end if;

    if v_has_pass = 0 then
        raise exception '이 센터의 수강권을 구매한 적이 있는 회원만 후기를 쓸 수 있어요';
    end if;

    select count(*) into v_exists
    from center_reviews where center_id = p_center_id and profile_id = p_profile_id;
    if v_exists > 0 then
        raise exception '이미 이 센터에 후기를 작성했어요';
    end if;

    insert into center_reviews (center_id, profile_id, rating, content, photos)
    values (p_center_id, p_profile_id, p_rating, p_content, p_photos);

    -- 포인트 적립
    select coalesce(review_point, 0) into v_point from centers where id = p_center_id;
    if v_point > 0 then
        insert into point_accounts (center_id, profile_id, balance)
        values (p_center_id, p_profile_id, v_point)
        on conflict (center_id, profile_id) do update
            set balance = point_accounts.balance + v_point,
                updated_at = now();

        insert into point_logs (center_id, profile_id, amount, reason, memo)
        values (p_center_id, p_profile_id, v_point, 'review', '후기 작성 적립');
    end if;

    return json_build_object('point', v_point);
end;
$$;


-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns
where table_name = 'center_reviews' order by ordinal_position;


-- ============================================================
-- 완료!
-- ============================================================
