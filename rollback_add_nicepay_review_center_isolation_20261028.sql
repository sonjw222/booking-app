-- add_nicepay_review_center_isolation_20261028.sql 되돌리기: 정책·트리거·신규 함수 삭제, 함수 4개를 이전 정의로 복원. centers.is_nicepay_review 컬럼과 심사 센터 데이터는 남긴다(데이터 보존).
-- ⚠ 안전장치: 롤백하면 분리 규칙이 사라져 심사 센터·상품·수업이 일반 회원에게 보일 수 있다. 일반 공개 가능 상태(승인된 비내부 심사 센터)가 하나라도 있으면 이 스크립트는 아무것도 바꾸지 않고 중단한다.
--   먼저 심사 센터를 비공개로 돌린다. 센터 하나만 닫으면 그 센터의 상품·수업 직접 조회까지 같이 막힌다(기존 "상품 조회"/"승인된 센터 수업 조회" 정책이 승인된 비내부 센터만 허용).
--   방법 ① SQL Editor: update centers set is_internal = true where is_nicepay_review;   -- 심사 센터 행만. 기존 운영 센터 변경 없음(is_internal 은 별도 보호 트리거가 없다)
--   방법 ② 플랫폼 관리자 계정으로 센터 승인 상태를 되돌림(status 는 guard_center_status_change 트리거가 플랫폼 관리자만 변경 허용 — SQL Editor 의 postgres 로는 변경 불가).
--   그 뒤 이 스크립트를 실행한다. (심사 센터 데이터는 삭제하지 않는다.)
-- ⚠ 추가 안전장치(2026-10-30): 정책 제거 전후로 실제 인증 컨텍스트(계정별 JWT)의 심사 센터·상품·수업 가시성을 측정해, 일반 회원 관계(center_members 등) 때문에 노출이 늘어나는 계정이 하나라도 있으면 전체 롤백한다. 관계 데이터는 자동 삭제·수정하지 않는다.
-- 남기는 것: accounts.nicepay_review_access 컬럼·보호 트리거(INSERT·UPDATE 모두 보호, 값이 있을 수 있어 데이터 보존. 완전 제거는 별도 승인)와 그 트리거가 의존하는 함수 2개(enforce_nicepay_review_access_admin_only, nicepay_is_client_request), centers.is_nicepay_review 컬럼.
-- 복원 규칙(기간 RPC): 분리 SQL 이 그 함수를 새로 만들었다면(함수 주석 표식) 삭제, 분리 SQL 적용 전부터 있었다면 add_public_storefront_product_periods_20261027.sql 정의로 복원.
BEGIN;
do $$
begin
  -- 역순 롤백 강제: P2b(게이트 함수 패치)가 적용돼 있으면 먼저 rollback_fix_nicepay_gate_reviewer_flag_20261029.sql 을 실행해야 한다(P2b 는 P2 의 컬럼에 의존).
  if to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is not null then
    raise exception '롤백 중단: P2b(NICEPAY 게이트 판별 패치)가 아직 적용돼 있어요. 먼저 rollback_fix_nicepay_gate_reviewer_flag_20261029.sql 을 실행하세요.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review')
     and exists (select 1 from centers where is_nicepay_review and status = 'approved' and not is_internal) then
    raise exception '롤백 중단: 일반 사용자에게 공개될 수 있는 심사 센터가 있어요. 먼저 update centers set is_internal = true where is_nicepay_review; 를 실행하세요(또는 플랫폼 관리자가 센터 승인 상태를 되돌리세요).';
  end if;
end $$;
-- ─ 노출 증가 검사 ①(정책을 지우기 "전" 기준값): 기존 센터 조회 정책은 "내부 센터라도 그 센터에 등록된 회원(center_members)·활성/비활성 매니저"에게 센터·상품·수업 조회를 허용한다.
--   그래서 심사 센터를 is_internal=true 로 닫아도, 심사 센터에 등록된 일반 회원이 남아 있으면 P2 분리 정책을 지우는 순간 그 회원에게 심사 센터가 보이게 된다.
--   실제 인증 컨텍스트(set local role + JWT sub)로 각 계정이 보는 심사 센터·상품·수업·구매 RPC 건수를 지금(정책 적용 중) 기록하고, 맨 끝(정책 제거 후)에 다시 측정해 "늘어난 계정"이 있으면 전체를 롤백한다.
--   대상 계정: 심사 센터에 회원 등록(center_members)·수강권·주문·장바구니·구매신청·예약이 있는 계정 + 심사 센터 매니저 + 최근 계정 30개(그 밖의 우회 경로 감시) + 비로그인(anon). 아무것도 삭제·수정하지 않는다.
do $$
declare v_ids uuid[]; r record;
begin
  select coalesce(array_agg(id), '{}') into v_ids from centers where is_nicepay_review;
  create temp table _nicepay_rb_probe(who text, auth_id uuid, sig text) on commit drop;   -- 이 트랜잭션 안에서만 존재(COMMIT/ROLLBACK 시 자동 삭제)
  create or replace function pg_temp.nicepay_rb_probe(p_auth uuid, p_ids uuid[]) returns text language plpgsql as $f$
  declare c int; p int; cl int; rp int; rs int;
  begin
    perform set_config('request.jwt.claims', case when p_auth is null then '' else json_build_object('sub', p_auth, 'role', 'authenticated')::text end, true);
    execute case when p_auth is null then 'set local role anon' else 'set local role authenticated' end;
    select count(*) into c from public.centers where id = any(p_ids);
    select count(*) into p from public.products where center_id = any(p_ids);
    select count(*) into cl from public.classes where center_id = any(p_ids);
    begin select count(*) into rp from unnest(p_ids) u(cid), lateral public.fetch_purchasable_products(u.cid) f;
    exception when insufficient_privilege then rp := 0; end;   -- 실행 권한이 없는 역할(anon 등)은 노출 0
    begin select count(*) into rs from unnest(p_ids) u(cid), lateral public.fetch_public_storefront_products(u.cid) f;
    exception when insufficient_privilege then rs := 0; end;
    execute 'reset role'; perform set_config('request.jwt.claims', '', true);
    return c || '/' || p || '/' || cl || '/' || rp || '/' || rs;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    raise exception '롤백 중단: 노출 여부를 확인하지 못했어요(%): % — 안전을 위해 아무것도 바꾸지 않습니다.', coalesce(p_auth::text, 'anon'), sqlerrm;
  end $f$;
  insert into _nicepay_rb_probe values ('anon', null, pg_temp.nicepay_rb_probe(null, v_ids));
  for r in
    select distinct a.auth_id from accounts a where a.auth_id is not null and (
      a.id in (select p.account_id from profiles p where p.id in (
          select profile_id from center_members where center_id = any(v_ids)
          union select profile_id from memberships where center_id = any(v_ids)
          union select profile_id from orders where center_id = any(v_ids)
          union select profile_id from cart_items where center_id = any(v_ids)
          union select profile_id from purchase_requests where center_id = any(v_ids)
          union select rs.profile_id from reservations rs join classes cl on cl.id = rs.class_id where cl.center_id = any(v_ids)))
      or a.id in (select account_id from manager_centers where center_id = any(v_ids))
      or a.id in (select id from accounts order by created_at desc limit 30))
  loop
    insert into _nicepay_rb_probe values (r.auth_id::text, r.auth_id, pg_temp.nicepay_rb_probe(r.auth_id, v_ids));
  end loop;
end $$;
drop policy if exists "nicepay_review_isolation" on centers;
drop policy if exists "nicepay_review_isolation" on classes;
drop policy if exists "nicepay_own_reservation_class" on classes;
drop policy if exists "nicepay_review_isolation" on products;
do $$
declare t text;
begin
  foreach t in array array['orders','memberships','cart_items','purchase_requests','reservations'] loop
    execute format('drop trigger if exists %I on %I', format('trg_%s_nicepay_review_guard', t), t);
    execute format('drop trigger if exists %I on %I', format('trg_%s_nicepay_review_guard_upd', t), t);
  end loop;
end $$;
drop trigger if exists trg_centers_nicepay_review_admin_only on centers;
create or replace function public.center_rows_visible(p_center_id uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $$
    select coalesce(
        p_center_id is null
        or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal)
        or p_center_id in (select public.my_member_center_ids())
        or p_center_id in (select public.my_managed_center_ids())
        or public.is_platform_admin(),
        false);
$$;

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

-- 기간 RPC: 분리 SQL 이 만든 것이면 삭제, 이전부터 있었으면 이전 정의로 복원
do $do$ begin
  if to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null then
    if coalesce(obj_description('fetch_public_storefront_product_periods(uuid)'::regprocedure, 'pg_proc'), '') like 'created_by:add_nicepay_review_center_isolation_20261028%' then
      drop function fetch_public_storefront_product_periods(uuid);
    else
      execute $f$create or replace function fetch_public_storefront_product_periods(p_center_id uuid default null)
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
      and (p_center_id is null or p.center_id = p_center_id)
    limit 500;
$$;$f$;
    end if;
  end if;
end $do$;
drop function if exists nicepay_class_has_my_reservation(uuid);
-- nicepay_is_client_request() 는 삭제하지 않는다: 남기는 accounts 보호 트리거(enforce_nicepay_review_access_admin_only)가 호출한다. 지우면 롤백 뒤 권한 컬럼을 건드리는 모든 INSERT/UPDATE(관리자·서버·SQL Editor 포함)가 "function does not exist" 로 실패한다.
drop function if exists nicepay_review_guard_center();
drop function if exists enforce_center_nicepay_review_admin_only();
drop function if exists nicepay_review_center_member_allowed(uuid);
drop function if exists nicepay_review_center_allowed(uuid);
drop function if exists nicepay_is_reviewer();
-- ─ 노출 증가 검사 ②(정책·함수 제거 "후"): 앞에서 기록한 계정별 건수와 비교해 하나라도 늘었으면 예외 → 이 파일의 모든 변경이 롤백된다(회원·프로필·주문·수강권·예약은 건드리지 않는다).
do $$
declare v_ids uuid[]; r record; v_new text; b int[]; a int[]; v_msg text := ''; v_n int := 0; v_rel int;
begin
  select coalesce(array_agg(id), '{}') into v_ids from centers where is_nicepay_review;
  for r in select * from _nicepay_rb_probe loop
    v_new := pg_temp.nicepay_rb_probe(r.auth_id, v_ids);
    b := string_to_array(r.sig, '/')::int[]; a := string_to_array(v_new, '/')::int[];
    if exists (select 1 from generate_subscripts(a, 1) i where a[i] > b[i]) then
      v_n := v_n + 1; if v_n <= 5 then v_msg := v_msg || format(' [%s 센터/상품/수업/구매RPC/공개RPC %s → %s]', left(r.who, 8), r.sig, v_new); end if;
    end if;
  end loop;
  if v_n > 0 then
    select count(*) into v_rel from center_members where center_id = any(v_ids);
    raise exception '롤백 중단: 이 롤백을 적용하면 심사 센터·상품·수업이 계정 %개에게 새로 보이게 돼요(심사 센터 회원 등록 %건 등).%  기존 센터 조회 정책이 "내부 센터라도 등록된 회원에게 조회 허용"이라서예요. 회원·프로필·주문·수강권·예약은 삭제·수정하지 않았고 P2 분리 정책도 그대로 유지돼요. 해결: 심사 센터의 회원 관계를 승인된 절차로 정리하거나, P2 분리 정책을 그대로 두세요(권장 — 롤백하지 않아도 일반 사용자에게는 보이지 않습니다).', v_n, v_rel, v_msg;
  end if;
  drop function pg_temp.nicepay_rb_probe(uuid, uuid[]);
end $$;
COMMIT;
