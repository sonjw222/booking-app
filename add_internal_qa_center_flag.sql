-- ============================================================
-- QA/내부 센터를 일반 사용자에게 숨기기 — centers.is_internal (2026-10-02)
--
-- 배경: Production에 자동 회귀 QA용 센터를 둬야 한다. reserve_class 계열 RPC가 centers.status='approved'를 요구하므로
--   status='pending'으로 숨길 수 없다 → "승인 상태"와 "일반 사용자 공개 여부"를 분리하는 명시적 flag를 둔다.
--   (이름 prefix 필터는 조회 경로 누락이 생기기 쉬워 쓰지 않는다.)
--
-- 감사 결과: 일반 사용자 공개 경로(홈/내 주변/카테고리/검색/문의 센터 검색/센터 상세)는 전부 centers 테이블 직접 조회라 RLS 한 곳으로
--   막을 수 있고, 수업·상품도 "승인된 센터" 정책으로 읽힌다. 그래서 클라이언트 쿼리는 바꾸지 않고(미적용 환경에서 컬럼 오류 위험 없음)
--   서버(RLS/RPC)에서 한 번에 숨긴다:
--     · centers 조회 정책: 승인 센터라도 is_internal이면 그 센터의 회원(center_members)/관리자/플랫폼 관리자만 볼 수 있다.
--     · classes / products 조회 정책: 같은 조건(직접 URL·UUID를 알아도 일반 계정/anon은 수업·상품이 보이지 않음).
--     · fetch_public_storefront_products(비로그인 공개 /products): is_internal 센터 제외.
--     · fetch_purchasable_products(회원용 RPC): 그 센터의 회원/관리자만 상품을 받는다.
--   QA 매니저(manager_centers)와 QA 회원(center_members)은 기존 관계 그대로 정상 접근한다. 기존 센터는 default false라 동작 불변.
--   reserve_class 등은 status='approved'만 보므로 영향 없음.
--
-- 이 파일은 flag 컬럼과 정책/RPC만 만든다 — 어떤 센터도 자동으로 internal로 바꾸지 않는다(QA fixture가 자기 센터에만 설정).
-- 여러 번 실행해도 안전. 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================

alter table centers add column if not exists is_internal boolean not null default false;

-- 내가 회원으로 등록된 센터 id(RLS 재귀 방지용 SECURITY DEFINER — my_managed_center_ids()와 같은 패턴).
-- 비로그인(anon)은 my_profile_ids()가 비어 항상 빈 결과이므로 PUBLIC/anon 실행을 유지한다(정책 평가에 필요).
create or replace function my_member_center_ids()
returns setof uuid
language sql stable
security definer
set search_path = public
as $$
    select cm.center_id from center_members cm
    where cm.profile_id in (select my_profile_ids());
$$;
revoke all on function my_member_center_ids() from public;
grant execute on function my_member_center_ids() to anon, authenticated, service_role;

drop policy if exists "승인된 센터 조회" on centers;
create policy "승인된 센터 조회"
    on centers for select using (
        (status = 'approved' and (not is_internal or id in (select my_member_center_ids())))
        or id in (select my_managed_center_ids())
        -- 가입 직후 승인대기 상태인 내 센터도 보이게 (status 필터 없음, 기존과 동일)
        or id in (select my_center_ids_any_status())
        or is_platform_admin()
    );

drop policy if exists "승인된 센터 수업 조회" on classes;
create policy "승인된 센터 수업 조회"
    on classes for select using (
        center_id in (
            select c.id from centers c
            where c.status = 'approved' and (not c.is_internal or c.id in (select my_member_center_ids()))
        )
        or center_id in (select my_managed_center_ids())
    );

drop policy if exists "상품 조회" on products;
create policy "상품 조회"
    on products for select using (
        center_id in (
            select c.id from centers c
            where c.status = 'approved' and (not c.is_internal or c.id in (select my_member_center_ids()))
        )
        or center_id in (select my_managed_center_ids())
    );

-- 비로그인 공개 상품 목록(add_public_storefront_products.sql의 현재 정의 + is_internal 제외)
create or replace function fetch_public_storefront_products(p_center_id uuid default null)
returns table (
    id             uuid,
    center_id      uuid,
    center_name    text,
    name           text,
    price          integer,
    product_kind   text,
    description    text,
    total_count    integer,
    unlimited      boolean,
    unlimited_pass boolean,
    group_label    text,
    remaining      integer,
    purchase_count_selectable boolean,
    min_purchase_count        integer,
    max_purchase_count        integer,
    min_tier_price            integer,
    max_tier_price            integer
)
language sql
stable
security definer
set search_path = public
as $$
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
$$;


revoke all on function fetch_public_storefront_products(uuid) from public;
grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;

-- 회원용 구매 가능 상품 RPC(라이브 정의 + 내부 센터는 그 센터의 회원/관리자만)
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

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select
    (select count(*) from information_schema.columns where table_name = 'centers' and column_name = 'is_internal') as flag_col_must_be_1,
    (select count(*) from centers where is_internal) as internal_centers_now,   -- 적용 직후엔 0(QA fixture가 만들 때만 증가)
    has_function_privilege('anon', 'fetch_public_storefront_products(uuid)', 'execute') as public_rpc_anon_ok,   -- true
    has_function_privilege('anon', 'fetch_purchasable_products(uuid)', 'execute') as member_rpc_anon_blocked;     -- false
select policyname, cmd from pg_policies where tablename in ('centers', 'classes', 'products') and cmd = 'SELECT' order by 1;
