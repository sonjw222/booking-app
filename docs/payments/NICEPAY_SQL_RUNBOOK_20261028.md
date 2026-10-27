# NICEPAY SQL 실행 런북 (2026-10-28) — 실행하지 않음, 승인 후에만

모든 SQL 은 운영·공유 DEV 에 **미실행**이다. 이 문서는 순서·효과·검증·롤백과 이번 작업 SQL 의 전문을 담는다. 준비 브랜치(`feat/nicepay-review-preparation-20261016`, 커밋 `6a847ee`)의 SQL 은 이번에 변경하지 않았으므로 경로·순서만 적고 전문은 그 브랜치 파일을 본다(합계 약 1,370줄).

## 순서
| # | 파일 | 효과 | 검증 | 롤백 |
|---|---|---|---|---|
| P0 | `preflight_nicepay_review_center_isolation_20261028.sql` | 읽기 전용. 운영 함수 정의 해시 대조·전제 확인 | `matches` 전부 true, `not_yet_applied` true | 해당 없음 |
| P1(선택) | `add_public_storefront_product_periods_20261027.sql` | 공개 기간 RPC 1개 추가 | 같은 파일 말미 확인 쿼리 | `rollback_add_public_storefront_product_periods_20261027.sql` |
| P2 | `add_nicepay_review_center_isolation_20261028.sql` | 센터 분리(컬럼 1·함수 5·정책 4·트리거 11·목록 함수 4 교체) | `verify_add_nicepay_review_center_isolation_20261028.sql` | `rollback_add_nicepay_review_center_isolation_20261028.sql` |
| P3(별도 승인) | `seed_nicepay_review_center_20261028.sql` | 심사 센터 1·상품 3 생성(값 확정 필요) | 시드 후 verify 의 심사 센터 수=1 | 심사 센터 삭제는 별도 승인(롤백 SQL 은 데이터 보존) |
| P3(별도 승인) | 심사관 지정 `update accounts set pg_checkout_override = true …` | 심사관 플래그 | 같은 verify | `… = false` |
| NICEPAY 활성화 시 | 준비 브랜치 SQL: `preflight_nicepay_patch_targets_20261016` → `fix_orders_insert_role_guard_20261017` → `fix_refund_pg_origin_guard_20261017` → `fix_refund_server_path_fail_closed_20261017` → `fix_refund_amount_integrity_20261017` → `add_nicepay_checkout_gate_20261017` → `add_nicepay_provider_support_20261016` → `fix_create_order_secure_allow_nicepay_20261016` → `fix_nicepay_claim_gate_20261017` | NICEPAY 결제 DB 기반·게이트 | 각 `verify_*` | 각 `rollback_*`(역순) |

심사관 지정 SQL(P3):
```sql
-- 승인 후, SQL Editor 에서만. 대상 계정이 확정(정책 결정 §7-1)된 뒤 실행.
update accounts set pg_checkout_override = true
where auth_id = (select id from auth.users where email = 'sonjw222@naver.com');   -- 되돌리기: = false
```

## P0 preflight — `preflight_nicepay_review_center_isolation_20261028.sql`
```sql
-- 읽기 전용 사전 점검 — add_nicepay_review_center_isolation_20261028.sql 을 운영에 적용하기 "전에" SQL Editor 에서 실행한다(변경 없음).
-- 분리 SQL 은 아래 3개 함수를 "현재 정의 + 한 줄 조건"으로 통째로 다시 만든다. 운영의 현재 정의가 아래 기대값(공유 DEV 와 같은 계보의 정의, 2026-10-28 로컬 측정)과 다르면
-- 운영에서 따로 바뀐 내용을 덮어쓸 수 있으므로 적용하지 말고 이 결과를 보내 정의 차이를 먼저 비교한다.
select 'center_rows_visible' as object, md5(pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) as actual_md5, '2be0d75899571b973f43d213713053e3' as expected_md5,
       md5(pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) = '2be0d75899571b973f43d213713053e3' as matches
union all select 'fetch_public_storefront_products', md5(pg_get_functiondef('public.fetch_public_storefront_products(uuid)'::regprocedure)), 'fda8e1821f997e9879c757187ab35a84',
       md5(pg_get_functiondef('public.fetch_public_storefront_products(uuid)'::regprocedure)) = 'fda8e1821f997e9879c757187ab35a84'
union all select 'fetch_purchasable_products', md5(pg_get_functiondef('public.fetch_purchasable_products(uuid)'::regprocedure)), '675be9c77818e1eb61552fc483e51b18',
       md5(pg_get_functiondef('public.fetch_purchasable_products(uuid)'::regprocedure)) = '675be9c77818e1eb61552fc483e51b18';
-- 전제 객체/컬럼(모두 true 여야 함)
select to_regprocedure('my_account_id()') is not null as my_account_id,
       to_regprocedure('my_managed_center_ids()') is not null as my_managed_center_ids,
       to_regprocedure('is_platform_admin()') is not null as is_platform_admin,
       exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounts' and column_name='pg_checkout_override') as pg_checkout_override_col,
       exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_internal') as is_internal_col,
       not exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review') as not_yet_applied,
       to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null as periods_rpc_exists_now;
-- 현재 센터/상품/수업 조회 정책(눈으로 확인: 승인된 센터 + is_internal 규칙이어야 함)
select tablename, policyname, pg_get_expr(q.polqual, q.polrelid) as using_expr from pg_policies p join pg_policy q on q.polname = p.policyname and q.polrelid = ('public.' || p.tablename)::regclass
 where p.tablename in ('centers','classes','products') and p.cmd = 'SELECT' order by 1, 2;
-- 영향 범위 미리보기: 심사관 계정 수와 내부/심사 후보 센터
select (select count(*) from accounts where pg_checkout_override and deactivated_at is null) as reviewer_accounts_now,
       (select string_agg(name, ' | ') from accounts where pg_checkout_override and deactivated_at is null) as reviewer_names,
       (select count(*) from centers) as centers_total, (select count(*) from centers where is_internal) as centers_internal;
```

## P2 적용 — `add_nicepay_review_center_isolation_20261028.sql`
```sql
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
```

## P2 검증 — `verify_add_nicepay_review_center_isolation_20261028.sql`
```sql
-- 읽기 전용 확인(SQL Editor/postgres 로 실행 — 변경 없음). 역할별 가시성은 아래 "역할 시뮬레이션"으로 확인한다.
-- 1) 객체
select
  (select count(*) from information_schema.columns where table_name='centers' and column_name='is_nicepay_review') as column_must_be_1,
  to_regprocedure('nicepay_review_center_allowed(uuid)') is not null as fn_allowed,
  to_regprocedure('nicepay_is_reviewer()') is not null as fn_reviewer,
  (select count(*) from pg_policies where policyname='nicepay_review_isolation') as restrictive_policies_must_be_3,
  (select count(*) from pg_policies where policyname='nicepay_own_reservation_class') as own_reservation_policy_must_be_1,
  (select count(*) from pg_trigger where tgname like '%nicepay_review%' and not tgisinternal) as triggers_must_be_11,
  has_function_privilege('public','nicepay_review_center_allowed(uuid)','execute') as public_exec_must_be_false;
-- 2) 기존 센터 보존: 아래 두 값은 적용 전후 같아야 한다(적용 전에 먼저 기록).
select (select count(*) from centers where not is_nicepay_review) as existing_centers,
       (select count(*) from products p join centers c on c.id=p.center_id where not c.is_nicepay_review) as existing_products;
-- 3) 심사 센터/심사관 현황(심사관 수는 의도한 1명인지 확인)
select (select count(*) from centers where is_nicepay_review) as review_centers,
       (select count(*) from accounts where pg_checkout_override and deactivated_at is null) as reviewer_accounts;
-- 4) 역할 시뮬레이션(트랜잭션 안에서만, 마지막에 ROLLBACK). <일반회원_auth_id>/<심사관_auth_id> 를 실제 값으로 바꿔 실행.
-- begin;
--   set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','<일반회원_auth_id>','role','authenticated')::text, true);
--   select count(*) as normal_sees_review_center_must_be_0 from centers where is_nicepay_review;
--   select count(*) as normal_sees_operating_centers from centers where not is_nicepay_review;
--   select set_config('request.jwt.claims', json_build_object('sub','<심사관_auth_id>','role','authenticated')::text, true);
--   select count(*) as reviewer_sees_review_center_must_be_1 from centers where is_nicepay_review;
--   select count(*) as reviewer_sees_operating_centers_must_be_0 from centers where not is_nicepay_review;
-- rollback;
```

## P2 롤백 — `rollback_add_nicepay_review_center_isolation_20261028.sql`
```sql
-- add_nicepay_review_center_isolation_20261028.sql 되돌리기: 정책·트리거·신규 함수 삭제, 함수 4개를 이전 정의로 복원. centers.is_nicepay_review 컬럼과 심사 센터 데이터는 남긴다(데이터 보존).
-- ⚠ 안전장치: 롤백하면 분리 규칙이 사라져 심사 센터·상품·수업이 일반 회원에게 보일 수 있다. 일반 공개 가능 상태(승인된 비내부 심사 센터)가 하나라도 있으면 이 스크립트는 아무것도 바꾸지 않고 중단한다.
--   먼저 심사 센터를 비공개로 돌린다. 센터 하나만 닫으면 그 센터의 상품·수업 직접 조회까지 같이 막힌다(기존 "상품 조회"/"승인된 센터 수업 조회" 정책이 승인된 비내부 센터만 허용).
--   방법 ① SQL Editor: update centers set is_internal = true where is_nicepay_review;   -- 심사 센터 행만. 기존 운영 센터 변경 없음(is_internal 은 별도 보호 트리거가 없다)
--   방법 ② 플랫폼 관리자 계정으로 센터 승인 상태를 되돌림(status 는 guard_center_status_change 트리거가 플랫폼 관리자만 변경 허용 — SQL Editor 의 postgres 로는 변경 불가).
--   그 뒤 이 스크립트를 실행한다. (심사 센터 데이터는 삭제하지 않는다.)
-- 복원 규칙(기간 RPC): 분리 SQL 이 그 함수를 새로 만들었다면(함수 주석 표식) 삭제, 분리 SQL 적용 전부터 있었다면 add_public_storefront_product_periods_20261027.sql 정의로 복원.
BEGIN;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review')
     and exists (select 1 from centers where is_nicepay_review and status = 'approved' and not is_internal) then
    raise exception '롤백 중단: 일반 사용자에게 공개될 수 있는 심사 센터가 있어요. 먼저 update centers set is_internal = true where is_nicepay_review; 를 실행하세요(또는 플랫폼 관리자가 센터 승인 상태를 되돌리세요).';
  end if;
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
drop function if exists nicepay_review_guard_center();
drop function if exists enforce_center_nicepay_review_admin_only();
drop function if exists nicepay_review_center_allowed(uuid);
drop function if exists nicepay_is_reviewer();
COMMIT;
```

## P3 시드(값 확정 필요) — `seed_nicepay_review_center_20261028.sql`
```sql
-- ============================================================
-- NICEPAY 카드사 심사 전용 센터·수강권 데이터 (2026-10-28) — 초안. 로컬 격리 DB 에서만 실행·검증했다. 운영/공유 DEV 에는 실행하지 않았다.
-- 운영 실행은 반드시 별도 승인이 필요하다(데이터 생성). 전제: add_nicepay_review_center_isolation_20261028.sql 이 먼저 적용돼 있어야 한다(그렇지 않으면 이 센터가 일반 회원에게 공개된다 — 아래 가드가 중단시킨다).
--
-- ⚠ 사용자 확정 필요 값(아래 v_* 값은 제안 placeholder):
--   · 센터 표시명, 상품 3종의 가격·이용기간, 서비스 내용 문구(실제 제공 가능한 서비스 또는 NICEPAY 가 승인한 심사용 거래만 허용)
--   · 센터 주소·사업자번호는 임의로 만들지 않는다(null). 필요하면 사업자등록증 기준으로 사용자가 채운다.
-- 이 센터는 "심사 환경"임을 이름·소개·상품 설명에 그대로 밝힌다(정상 운영 센터처럼 보이게 하지 않는다).
-- 기존 센터·상품·회원 데이터는 읽거나 바꾸지 않는다. 같은 이름의 센터가 이미 있으면 아무것도 하지 않는다(멱등).
-- 취소·환불 기준은 새로 정하지 않고 기존 환불 정책(/legal/refund)을 그대로 따른다고만 안내한다.
-- ============================================================
BEGIN;
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name='centers' and column_name='is_nicepay_review')
     or to_regprocedure('nicepay_review_center_allowed(uuid)') is null then
    raise exception '먼저 add_nicepay_review_center_isolation_20261028.sql 을 적용하세요(분리 없이 심사 센터를 만들면 일반 회원에게 노출됩니다)';
  end if;
end $$;

with c as (
  insert into centers(name, status, is_nicepay_review, is_internal, intro, categories)
  select '[심사 전용] MWHABIT NICEPAY 카드사 심사 환경', 'approved', true, false,
         'NICEPAY 카드사 심사를 위해 심사관에게만 제공되는 심사 전용 센터입니다. 일반 회원에게는 노출되지 않으며, 표시된 상품은 심사용 거래입니다. 취소·환불은 모하빗 환불 정책(환불정책 페이지)을 따릅니다.',
         '{}'
  where not exists (select 1 from centers where is_nicepay_review and name like '[심사 전용]%')
  returning id
), s as (insert into center_settings(center_id) select id from c returning center_id)
insert into products(center_id, name, price, product_kind, pass_type, total_count, unlimited_pass, expiry_mode, expiry_days, purchase_count_selectable, is_active, is_on_sale, visibility_type, description)
select c.id, v.name, v.price, 'pass', v.pt, v.cnt, v.unl, 'days', v.days, false, true, true, 'all', v.descr
from c, (values
  -- (이름, 가격 ⚠확정 필요, 유형, 횟수, 무제한, 이용기간(일), 설명)
  ('[심사용] 1회 수업 이용권',  1000, 'count',  1, false,  7, 'NICEPAY 심사용 상품 · 1회 수업 이용. 결제일부터 7일간 이용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준.'),
  ('[심사용] 4주 수업 이용권',  4000, 'period', null, true, 28, 'NICEPAY 심사용 상품 · 4주(28일) 기간제 이용. 결제일부터 28일간 이용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준.'),
  ('[심사용] 3개월 수업 이용권', 10000, 'period', null, true, 90, 'NICEPAY 심사용 상품 · 3개월(90일) 기간제 이용. 결제일부터 90일간 이용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준.')
) as v(name, price, pt, cnt, unl, days, descr);
COMMIT;
```

## P1 선행 기간 RPC(`026175a`) — `add_public_storefront_product_periods_20261027.sql`
```sql
-- ============================================================
-- 공개 판매상품의 이용기간 원본 조회 RPC (추가 전용, 검토용 — 실행하지 않음)
--
-- 배경: NICEPAY 카드사 심사 사전 보완 요청 — "서비스 제공기간(시작일~종료일)과 사전예약기간(결제일~서비스 시작일)을 고객이 확인할 수 있게 명시".
-- 로그인 회원용 상품 목록(fetch_purchasable_products = select p.*)은 이미 expiry_* 컬럼을 반환하므로 앱만 고치면 된다.
-- 비로그인 공개 목록(fetch_public_storefront_products)은 반환 컬럼이 고정돼 있고 RETURNS TABLE 시그니처는 create or replace 로 바꿀 수 없다(바꾸려면 DROP 필요).
-- 그래서 기존 함수는 건드리지 않고, 같은 노출 조건으로 "상품 id + 이용기간 원본 5개 컬럼"만 돌려주는 새 함수를 추가한다.
--
-- 안전:
--  · 새 함수만 추가한다. 테이블/컬럼/기존 함수/정책을 바꾸거나 지우지 않는다. 데이터 변경 없음.
--  · 노출 조건은 fetch_public_storefront_products 와 동일하다(승인된 센터, 내부 QA 센터 제외, 활성·판매중·전체공개, 횟수 선택형은 가격표가 있는 것만).
--  · 반환 컬럼은 이용기간 원본뿐이다(가격·설명·판매 수량 등 다른 정보를 추가로 공개하지 않는다).
--  · SECURITY DEFINER + search_path 고정, PUBLIC 권한 회수 후 anon/authenticated 에만 실행 허용.
--  · 앱은 이 함수가 없거나 실패하면 조용히 무시하고 "기간 공통 안내"만 보인다(앱이 먼저 배포돼도 안전).
-- 되돌리기: rollback_add_public_storefront_product_periods_20261027.sql
-- 확인(읽기 전용): verify_add_public_storefront_product_periods_20261027.sql
-- ============================================================

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
      and (p_center_id is null or p.center_id = p_center_id)
    limit 500;
$$;

revoke all on function fetch_public_storefront_product_periods(uuid) from public;
grant execute on function fetch_public_storefront_product_periods(uuid) to anon, authenticated;

comment on function fetch_public_storefront_product_periods(uuid) is
  '비로그인 포함 누구나 호출 가능. fetch_public_storefront_products 와 같은 노출 조건의 상품에 대해 이용기간 원본(expiry_mode/days/date, rolling_month 컷오프/early-use)만 반환한다.';

-- 확인(읽기 전용)
select
    to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null as function_exists,
    has_function_privilege('anon', 'fetch_public_storefront_product_periods(uuid)', 'execute') as anon_can_execute,
    has_function_privilege('authenticated', 'fetch_public_storefront_product_periods(uuid)', 'execute') as authenticated_can_execute;
```
