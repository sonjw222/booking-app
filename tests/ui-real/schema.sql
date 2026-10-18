-- 격리 QA용 최소 스키마(로컬 PostgreSQL + PostgREST 전용). 공유 DEV/운영과 무관하다.
-- 목적: 종목 목록(센터·후기 집계)·수업 상세(수업·룸·강사·정원·허용 수강권) 화면이 실제 PostgREST 질의(임베드/필터/범위 조회)와 실제 PostgreSQL 데이터로 동작하는지 확인.
-- 한계: 운영 RLS 전체가 아니라 "비로그인(anon) 읽기" 정책만 단순화해 재현한다(운영 DEV에서 anon 이 approved 센터·center_reviews 를 읽는 것을 별도로 확인함).
create role anon nologin; create role authenticated nologin; create role authenticator noinherit login password 'qa_authenticator';
grant anon, authenticated to authenticator;
create table centers (id uuid primary key, name text not null, categories text[] default '{}', intro text, address text, photo_url text, phone text, sns text, intro_blocks jsonb default '[]', pay_methods text[], review_point int default 1000,
  latitude double precision, longitude double precision, status text not null default 'approved', created_at timestamptz not null default now());
create table rooms (id uuid primary key, center_id uuid references centers(id), name text not null);
create table products (id uuid primary key, center_id uuid references centers(id), name text not null);
create table center_reviews (id uuid primary key default gen_random_uuid(), center_id uuid not null references centers(id) on delete cascade, profile_id uuid not null, rating int not null check (rating between 1 and 5), content text not null default 'x', created_at timestamptz not null default now(), unique (center_id, profile_id));
create table classes (id uuid primary key, center_id uuid not null references centers(id), title text not null, description text, class_format text not null default 'group', place text, room_id uuid references rooms(id),
  start_time timestamptz not null, end_time timestamptz not null, capacity int not null default 1, status text not null default 'open', booking_deadline_min int, pass_selection_mode text not null default 'all', created_at timestamptz default now());
create table reservations (id uuid primary key default gen_random_uuid(), class_id uuid not null references classes(id), status text not null default 'confirmed');
create view class_reservation_counts as select class_id, count(*) filter (where status = 'confirmed')::int as confirmed_count from reservations group by class_id;
create table class_allowed_products (class_id uuid references classes(id), product_id uuid references products(id), primary key (class_id, product_id));
create table class_trainers (class_id uuid references classes(id), trainer_name text, sort_order int default 0);
create function class_trainer_names(p_class_ids uuid[]) returns table(class_id uuid, name text, sort_order int) language sql stable as $$ select t.class_id, t.trainer_name, t.sort_order from class_trainers t where t.class_id = any(p_class_ids) order by t.class_id, t.sort_order $$;
create function my_account_id() returns uuid language sql stable as $$ select null::uuid $$;
alter table centers enable row level security; alter table center_reviews enable row level security; alter table classes enable row level security; alter table rooms enable row level security; alter table products enable row level security; alter table class_allowed_products enable row level security; alter table class_trainers enable row level security; alter table reservations enable row level security;
create policy c_read on centers for select using (status = 'approved'); create policy r_read on center_reviews for select using (true); create policy k_read on classes for select using (true); create policy rm_read on rooms for select using (true);
create policy p_read on products for select using (true); create policy ap_read on class_allowed_products for select using (true); create policy t_read on class_trainers for select using (true); create policy rs_read on reservations for select using (true);
grant usage on schema public to anon, authenticated;
grant select on centers, center_reviews, classes, rooms, products, class_reservation_counts, class_allowed_products, class_trainers, reservations to anon, authenticated;
grant execute on function class_trainer_names(uuid[]), my_account_id() to anon, authenticated;
