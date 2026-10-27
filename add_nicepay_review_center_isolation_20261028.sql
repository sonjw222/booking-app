-- ============================================================
-- NICEPAY 카드사 심사 전용 센터 분리 (2026-10-28) — 검토용 초안, 로컬 격리 DB 에서만 실행·검증했다. 운영/공유 DEV 미실행.
--
-- 목적: NICEPAY 심사 전용 센터·수강권을 만들어도
--   · 일반 회원/비회원에게는 그 센터·수업·상품이 어떤 경로로도 보이지 않고(목록·직접 URL·RPC·구매·예약),
--   · 심사관 계정(accounts.pg_checkout_override = true — 기존 심사관 권한)에게는 심사 센터만 보이고 기존 운영 센터는 보이지 않게 한다.
--   기존 센터·상품·주문·수강권·예약 데이터는 읽기/수정/삭제하지 않는다(행 변경 0). 새 컬럼 1개 + 함수 + 정책 + 트리거 + 기존 함수 4개 정의 교체.
--
-- 적용 순서(전제): ① (선택) add_public_storefront_product_periods_20261027.sql — 이 파일이 같은 함수를 조건 추가 버전으로 다시 만들므로 ①이 없어도 안전하다
--                   ② 이 파일  ③ (별도 승인, 데이터 생성) seed_nicepay_review_center_20261028.sql
-- 전제 객체: accounts.pg_checkout_override(add_pg_checkout_reviewer_override.sql), centers.is_internal(add_internal_qa_center_flag.sql),
--           my_account_id()/my_managed_center_ids()/is_platform_admin()/center_rows_visible()/product_rows_visible() — 운영에 없으면 아래 preflight 가 실패한다.
-- 되돌리기: rollback_add_nicepay_review_center_isolation_20261028.sql (기존 정의로 복원, 새 객체 삭제 — 컬럼은 데이터 보존을 위해 남긴다)
-- 확인(읽기 전용): verify_add_nicepay_review_center_isolation_20261028.sql
--
-- 접근 기준(요약)
--   · 플랫폼 관리자, 해당 센터의 활성 매니저: 항상 접근(기존 관리 기능 유지)
--   · 심사 센터(centers.is_nicepay_review): 심사관만. 그 외 회원/비회원은 불가
--   · 일반(운영) 센터: 심사관은 불가(심사관이 매니저/플랫폼 관리자인 센터는 예외), 그 외는 기존과 동일
--   · 기존 is_internal 규칙은 그대로 유지(추가로 AND 로 겹침 — 대체하지 않는다)
-- ============================================================
BEGIN;

-- 롤백이 이전 상태를 정확히 복원하도록, 기간 RPC 가 이 파일 적용 전에 있었는지 기록한다(없었으면 이 파일이 만든 것 → 롤백 시 삭제).
create temp table _nicepay_periods_existed on commit drop as select to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null as existed;

-- preflight: 전제 객체가 없으면 중단(부분 적용 방지)
do $$
begin
  if to_regprocedure('my_account_id()') is null or to_regprocedure('my_managed_center_ids()') is null
     or to_regprocedure('is_platform_admin()') is null or to_regprocedure('center_rows_visible(uuid)') is null
     or to_regprocedure('fetch_public_storefront_products(uuid)') is null or to_regprocedure('fetch_purchasable_products(uuid)') is null then
    raise exception 'NICEPAY 심사 분리: 전제 함수가 없습니다(운영 정의 확인 필요)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounts' and column_name='pg_checkout_override') then
    raise exception 'NICEPAY 심사 분리: accounts.pg_checkout_override 가 없습니다';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_internal') then
    raise exception 'NICEPAY 심사 분리: centers.is_internal 이 없습니다';
  end if;
end $$;

alter table centers add column if not exists is_nicepay_review boolean not null default false;
comment on column centers.is_nicepay_review is 'NICEPAY 카드사 심사 전용 센터. true 이면 심사관 계정(accounts.pg_checkout_override)과 해당 센터 매니저/플랫폼 관리자에게만 보인다.';

-- 이 값은 운영자(플랫폼 관리자)/SQL Editor(auth.uid() is null)만 바꿀 수 있다 — 센터 매니저가 자기 센터를 심사 센터로 바꾸거나 심사 센터를 만들 수 없다.
create or replace function enforce_center_nicepay_review_admin_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.is_nicepay_review) or (tg_op = 'UPDATE' and new.is_nicepay_review is distinct from old.is_nicepay_review) then
    if auth.uid() is not null and not is_platform_admin() then
      raise exception '이 값은 운영자만 변경할 수 있어요';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_centers_nicepay_review_admin_only on centers;
create trigger trg_centers_nicepay_review_admin_only before insert or update on centers
  for each row execute function enforce_center_nicepay_review_admin_only();

-- 심사관 판정: 인증된 사용자(auth.uid())의 계정에 대해서만. 이메일 문자열은 쓰지 않는다. 비로그인은 false.
create or replace function nicepay_is_reviewer()
returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select a.pg_checkout_override from accounts a where a.id = my_account_id() and a.deactivated_at is null), false);
$$;
revoke all on function nicepay_is_reviewer() from public;
grant execute on function nicepay_is_reviewer() to anon, authenticated, service_role;

-- 센터 접근 판정(단일 기준). service_role 은 RLS 를 타지 않는다.
create or replace function nicepay_review_center_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() or p_center_id in (select my_managed_center_ids()) then true
        when exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review) then nicepay_is_reviewer()
        else not nicepay_is_reviewer()
    end;
$$;
revoke all on function nicepay_review_center_allowed(uuid) from public;
grant execute on function nicepay_review_center_allowed(uuid) to anon, authenticated, service_role;

-- center_rows_visible 에 같은 기준을 AND 로 추가 → 이 함수를 쓰는 정책(휴무일·리뷰·커뮤니티·룸·상담채널·설정·센터항목·센터후기·진도카테고리)과 class_rows_visible/product_rows_visible 이 한 번에 따라온다.
create or replace function public.center_rows_visible(p_center_id uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $$
    select coalesce(
        (
            p_center_id is null
            or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal)
            or p_center_id in (select public.my_member_center_ids())
            or p_center_id in (select public.my_managed_center_ids())
            or public.is_platform_admin()
        ) and public.nicepay_review_center_allowed(p_center_id),
        false);
$$;

-- 기존 허용 정책에 AND 로 겹치는 제한 정책(대체 아님 — 기존 정책은 그대로 둔다)
drop policy if exists "nicepay_review_isolation" on centers;
create policy "nicepay_review_isolation" on centers as restrictive for select using (nicepay_review_center_allowed(id));
drop policy if exists "nicepay_review_isolation" on classes;
-- 수업은 예외 1가지: 내 프로필의 예약이 이미 걸린 수업은 센터가 숨겨져도 읽을 수 있다(심사관이 되기 전에 만든 기존 예약을 내 예약 화면에서 보고 취소할 수 있게 — 사후 처리 보존).
-- 센터·상품 목록/구매에는 영향 없음(센터·상품 정책은 예외 없음, 새 예약은 INSERT 트리거가 막는다).
create or replace function nicepay_class_has_my_reservation(p_class_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from reservations r where r.class_id = p_class_id and r.profile_id in (select my_profile_ids()));
$$;
revoke all on function nicepay_class_has_my_reservation(uuid) from public;
grant execute on function nicepay_class_has_my_reservation(uuid) to anon, authenticated, service_role;
create policy "nicepay_review_isolation" on classes as restrictive for select using (nicepay_review_center_allowed(center_id) or nicepay_class_has_my_reservation(id));
-- 기존 허용 정책("승인된 센터 수업 조회")은 centers 를 서브쿼리로 읽는데 그 centers 가 심사관에게 숨겨지므로, 내 예약이 걸린 수업만 읽는 허용 정책을 추가한다(내 예약만 — 다른 수업은 그대로 숨김).
drop policy if exists "nicepay_own_reservation_class" on classes;
create policy "nicepay_own_reservation_class" on classes for select using (nicepay_class_has_my_reservation(id));
drop policy if exists "nicepay_review_isolation" on products;
create policy "nicepay_review_isolation" on products as restrictive for select using (nicepay_review_center_allowed(center_id));

-- 구매·예약·수강권 발급 경로(RPC 는 SECURITY DEFINER 라 RLS 를 우회하고, orders INSERT 정책은 클라이언트가 보낸 center_id 와 product_id 의 일치를 보지 않는다).
-- 그래서 행이 가리키는 "모든" 센터(행의 center_id + 상품의 실제 센터 + 수업의 센터 + 수강권의 센터)가 호출자에게 허용된 센터인지 테이블 트리거로 확인한다.
-- 클라이언트가 보낸 center_id 만 믿지 않는다. auth.uid() is null(서버/service_role)은 통과. UPDATE 는 해당 컬럼이 실제로 바뀔 때만 검사한다.
create or replace function nicepay_review_guard_center()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_centers uuid[] := '{}'; v_c uuid; v_row jsonb := to_jsonb(new);
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'reservations' then
    select c.center_id into v_c from classes c where c.id = (v_row->>'class_id')::uuid;
    if v_c is not null then v_centers := v_centers || v_c; end if;
    select m.center_id into v_c from memberships m where m.id = (v_row->>'membership_id')::uuid;
    if v_c is not null then v_centers := v_centers || v_c; end if;
  else
    if (v_row->>'center_id') is not null then v_centers := v_centers || (v_row->>'center_id')::uuid; end if;
    select p.center_id into v_c from products p where p.id = (v_row->>'product_id')::uuid;
    if v_c is not null then v_centers := v_centers || v_c; end if;
  end if;
  foreach v_c in array v_centers loop
    if not nicepay_review_center_allowed(v_c) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  end loop;
  return new;
end $$;
do $$
declare t text; ins text := 'trg_%s_nicepay_review_guard'; upd text := 'trg_%s_nicepay_review_guard_upd';
begin
  foreach t in array array['orders','memberships','cart_items','purchase_requests'] loop
    execute format('drop trigger if exists %I on %I', format(ins, t), t);
    execute format('create trigger %I before insert on %I for each row execute function nicepay_review_guard_center()', format(ins, t), t);
    execute format('drop trigger if exists %I on %I', format(upd, t), t);
    execute format('create trigger %I before update of center_id, product_id on %I for each row when (old.center_id is distinct from new.center_id or old.product_id is distinct from new.product_id) execute function nicepay_review_guard_center()', format(upd, t), t);
  end loop;
  execute 'drop trigger if exists trg_reservations_nicepay_review_guard on reservations';
  execute 'create trigger trg_reservations_nicepay_review_guard before insert on reservations for each row execute function nicepay_review_guard_center()';
  execute 'drop trigger if exists trg_reservations_nicepay_review_guard_upd on reservations';
  execute 'create trigger trg_reservations_nicepay_review_guard_upd before update of class_id, membership_id on reservations for each row when (old.class_id is distinct from new.class_id or old.membership_id is distinct from new.membership_id) execute function nicepay_review_guard_center()';
end $$;

-- 목록 RPC 3개(SECURITY DEFINER — RLS 우회). 현재 정의 + nicepay_review_center_allowed 조건만 추가.
CREATE OR REPLACE FUNCTION public.fetch_public_storefront_products(p_center_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, center_id uuid, center_name text, name text, price integer, product_kind text, description text, total_count integer, unlimited boolean, unlimited_pass boolean, group_label text, remaining integer, purchase_count_selectable boolean, min_purchase_count integer, max_purchase_count integer, min_tier_price integer, max_tier_price integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select
        p.id,
        p.center_id,
        c.name,
        p.name,
        p.price,
        p.product_kind,
        p.description,
        p.total_count,
        p.unlimited,
        p.unlimited_pass,
        p.group_label,
        case
            when p.max_quantity is null then null
            else greatest(
                0,
                p.max_quantity - (
                    select count(*)::int from memberships m
                    where m.product_id = p.id and m.status <> 'refunded'
                )
            )
        end,
        coalesce(p.purchase_count_selectable, false),
        (select min(t.count) from product_count_prices t where t.product_id = p.id),
        (select max(t.count) from product_count_prices t where t.product_id = p.id),
        (select min(t.price) from product_count_prices t where t.product_id = p.id),
        (select max(t.price) from product_count_prices t where t.product_id = p.id)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal   -- QA/내부 센터는 공개 목록에 절대 나오지 않는다
      and nicepay_review_center_allowed(c.id)   -- [NICEPAY 심사 분리] 심사 센터는 심사관에게만, 심사관에게는 심사 센터만
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      -- 횟수 선택형인데 가격표가 아직 없으면(설정 중) 공개하지 않는다
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    order by c.name asc, p.product_kind asc, p.price asc
    limit 500;
$function$;
revoke all on function fetch_public_storefront_products(uuid) from public;
grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;

CREATE OR REPLACE FUNCTION public.fetch_purchasable_products(p_center_id uuid)
 RETURNS SETOF products
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select p.* from products p
    where p.center_id = p_center_id
      and nicepay_review_center_allowed(p.center_id)   -- [NICEPAY 심사 분리]
      -- QA/내부 센터(centers.is_internal)는 그 센터의 회원/관리자만 상품을 조회할 수 있다(UUID를 알아도 일반 계정은 빈 목록)
      and (
        not exists (select 1 from centers c where c.id = p.center_id and c.is_internal)
        or p.center_id in (select my_member_center_ids())
        or p.center_id in (select my_managed_center_ids())
      )
      and p.is_active
      and p.is_on_sale
      and (
        p.visibility_type = 'all'
        or (
            p.visibility_type = 'grades' and exists (
                select 1 from membership_product_grades mpg
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.grade_id = mpg.grade_id
                where mpg.product_id = p.id
            )
        )
        or (
            p.visibility_type = 'selected_members' and exists (
                select 1 from membership_product_members mpm
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.id = mpm.center_member_id
                where mpm.product_id = p.id
            )
        )
      )
    order by p.product_kind asc, p.price asc;
$function$;
revoke all on function public.fetch_purchasable_products(uuid) from public, anon;
grant execute on function public.fetch_purchasable_products(uuid) to authenticated, service_role;

create or replace function fetch_public_storefront_product_periods(p_center_id uuid default null)
returns table (
    product_id uuid,
    expiry_mode text,
    expiry_days integer,
    expiry_date date,
    rolling_month_cutoff_day integer,
    rolling_month_allow_early_use boolean
)
language sql
stable
security definer
set search_path = public
as $$
    select
        p.id,
        p.expiry_mode,
        p.expiry_days,
        p.expiry_date,
        p.rolling_month_cutoff_day,
        coalesce(p.rolling_month_allow_early_use, false)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and nicepay_review_center_allowed(c.id)   -- [NICEPAY 심사 분리]
      and (p_center_id is null or p.center_id = p_center_id)
    limit 500;
$$;
revoke all on function fetch_public_storefront_product_periods(uuid) from public;
grant execute on function fetch_public_storefront_product_periods(uuid) to anon, authenticated;
do $$ begin
  if not (select existed from _nicepay_periods_existed) then
    comment on function fetch_public_storefront_product_periods(uuid) is 'created_by:add_nicepay_review_center_isolation_20261028 (rollback 시 삭제)';
  end if;
end $$;

COMMIT;
