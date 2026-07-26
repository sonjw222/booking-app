-- ============================================================
-- 센터 후기 + 포인트
--
-- 하는 일:
--   1) reviews        : 센터 후기 (수강권 구매자만 작성 가능)
--   2) point_accounts : 회원의 센터별 포인트 잔액
--   3) point_logs     : 포인트 적립/사용 내역
--   4) 후기 작성 시 자동 적립 (센터가 정한 금액)
--   5) centers.review_point : 후기 1건당 지급 포인트
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 센터별 후기 적립 포인트 설정
alter table centers add column if not exists review_point int not null default 1000;

-- 1) 후기
create table if not exists reviews (
    id          uuid primary key default gen_random_uuid(),
    created_at  timestamptz not null default now()
);
-- 빠진 컬럼 개별 보강 (이미 다른 구조로 있어도 안전)
alter table reviews add column if not exists center_id  uuid references centers(id) on delete cascade;
alter table reviews add column if not exists profile_id uuid references profiles(id) on delete cascade;
alter table reviews add column if not exists rating     int;
alter table reviews add column if not exists content    text;

-- 한 회원당 센터별 후기 1개 (이미 있으면 무시)
do $idx$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'reviews_center_profile_key'
    ) then
        alter table reviews add constraint reviews_center_profile_key unique (center_id, profile_id);
    end if;
end
$idx$;

-- 2) 포인트 잔액 (센터별)
create table if not exists point_accounts (
    id          uuid primary key default gen_random_uuid(),
    updated_at  timestamptz not null default now()
);
alter table point_accounts add column if not exists center_id  uuid references centers(id) on delete cascade;
alter table point_accounts add column if not exists profile_id uuid references profiles(id) on delete cascade;
alter table point_accounts add column if not exists balance    int not null default 0;

do $idx$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'point_accounts_center_profile_key'
    ) then
        alter table point_accounts add constraint point_accounts_center_profile_key unique (center_id, profile_id);
    end if;
end
$idx$;

-- 3) 포인트 내역
create table if not exists point_logs (
    id          uuid primary key default gen_random_uuid(),
    created_at  timestamptz not null default now()
);
alter table point_logs add column if not exists center_id  uuid references centers(id) on delete cascade;
alter table point_logs add column if not exists profile_id uuid references profiles(id) on delete cascade;
alter table point_logs add column if not exists amount     int;
alter table point_logs add column if not exists reason     text;
alter table point_logs add column if not exists memo       text;

-- 별점 범위 제약 (없으면 추가)
do $idx$
begin
    if not exists (select 1 from pg_constraint where conname = 'reviews_rating_range') then
        alter table reviews add constraint reviews_rating_range check (rating between 1 and 5);
    end if;
end
$idx$;

create index if not exists idx_point_logs_profile on point_logs(profile_id, created_at desc);
create index if not exists idx_reviews_center on reviews(center_id, created_at desc);


-- ============================================================
-- RLS
-- ============================================================
alter table reviews        enable row level security;
alter table point_accounts enable row level security;
alter table point_logs     enable row level security;

-- 후기: 누구나 조회, 본인만 작성/수정/삭제
drop policy if exists "후기 공개 조회" on reviews;
create policy "후기 공개 조회" on reviews for select using (true);

drop policy if exists "후기 본인 작성" on reviews;
create policy "후기 본인 작성" on reviews for insert
    with check (profile_id in (select my_profile_ids()));

drop policy if exists "후기 본인 수정" on reviews;
create policy "후기 본인 수정" on reviews for update
    using (profile_id in (select my_profile_ids()));

drop policy if exists "후기 본인 삭제" on reviews;
create policy "후기 본인 삭제" on reviews for delete
    using (profile_id in (select my_profile_ids()));

-- 포인트: 본인 것만 조회 (매니저는 자기 센터 것 조회)
drop policy if exists "포인트 조회" on point_accounts;
create policy "포인트 조회" on point_accounts for select
    using (
        profile_id in (select my_profile_ids())
        or center_id in (select my_managed_center_ids())
        or is_platform_admin()
    );

drop policy if exists "포인트내역 조회" on point_logs;
create policy "포인트내역 조회" on point_logs for select
    using (
        profile_id in (select my_profile_ids())
        or center_id in (select my_managed_center_ids())
        or is_platform_admin()
    );


-- ============================================================
-- 후기 작성 + 포인트 자동 적립
--   - 그 센터 수강권을 산 적 있는 회원만 작성 가능
--   - 센터가 정한 review_point 만큼 적립
-- ============================================================

create or replace function write_review(
    p_center_id uuid,
    p_profile_id uuid,
    p_rating int,
    p_content text
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
    -- 본인 프로필인지 확인
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 프로필로만 후기를 쓸 수 있어요';
    end if;

    -- 수강권 구매 이력 확인 (환불된 것도 구매는 한 것으로 인정)
    select count(*) into v_has_pass
    from memberships
    where profile_id = p_profile_id and center_id = p_center_id;
    if v_has_pass = 0 then
        raise exception '이 센터의 수강권을 구매한 회원만 후기를 쓸 수 있어요';
    end if;

    -- 중복 확인
    select count(*) into v_exists
    from reviews where center_id = p_center_id and profile_id = p_profile_id;
    if v_exists > 0 then
        raise exception '이미 이 센터에 후기를 작성했어요';
    end if;

    insert into reviews (center_id, profile_id, rating, content)
    values (p_center_id, p_profile_id, p_rating, p_content);

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
-- 포인트 사용 (결제 시 차감)
-- ============================================================

create or replace function use_points(
    p_center_id uuid,
    p_profile_id uuid,
    p_amount int
)
returns json
language plpgsql
security definer
as $$
declare
    v_balance int;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 포인트만 사용할 수 있어요';
    end if;
    if p_amount <= 0 then
        return json_build_object('used', 0);
    end if;

    select coalesce(balance, 0) into v_balance
    from point_accounts
    where center_id = p_center_id and profile_id = p_profile_id
    for update;

    if coalesce(v_balance, 0) < p_amount then
        raise exception '포인트가 부족해요';
    end if;

    update point_accounts
       set balance = balance - p_amount, updated_at = now()
     where center_id = p_center_id and profile_id = p_profile_id;

    insert into point_logs (center_id, profile_id, amount, reason, memo)
    values (p_center_id, p_profile_id, -p_amount, 'purchase', '결제 시 사용');

    return json_build_object('used', p_amount);
end;
$$;


-- ============================================================
-- 확인
-- ============================================================
select 'reviews' as t, count(*) from reviews
union all select 'point_accounts', count(*) from point_accounts
union all select 'point_logs', count(*) from point_logs;


-- ============================================================
-- 완료!
--   회원: 센터 상세 → 후기 작성 → 포인트 적립
--   결제 시 포인트 사용 가능
-- ============================================================
