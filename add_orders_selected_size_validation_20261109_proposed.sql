-- ============================================================
-- 주문 생성 시 "선택 사이즈" 서버 검증 (2026-11-09) — 제안(PROPOSED)·운영/공유 DEV 미실행. 사용자가 전문과 영향을 검토·승인한 뒤에만 SQL Editor 에서 실행한다.
--
-- 배경: orders 는 클라이언트가 직접 INSERT 한다. 횟수(selected_count)·금액은 orders_snapshot_product_amount 트리거(add_selectable_count_pricing.sql)가 서버에서 검증·확정하지만,
--       selected_size 는 서버가 검사하지 않아 조작된 클라이언트는 (a) 사이즈 필수 상품을 사이즈 없이 (b) 상품에 없는 사이즈로 (c) 사이즈 없는 상품에 임의 값으로 주문할 수 있다.
--       앱(lib/orderOptions.ts)은 막지만 서버 방어선이 없다.
--
-- 하는 일(새 함수 1개 + 새 트리거 1개 — 기존 데이터는 읽기만 하고 수정/삭제하지 않는다):
--   BEFORE INSERT ON orders: products.sizes 가 비어 있지 않으면 selected_size 는 그 목록 중 하나여야 하고(필수),
--   비어 있으면 selected_size 는 NULL/빈 문자열이어야 한다. 위반 시 예외로 INSERT 를 거부한다(한국어 메시지).
--   적용 범위: 로그인한 클라이언트 세션(auth.uid() 있음)만. 서버 함수/service_role/cron(auth.uid() 없음)은 영향 없음 — orders_guard_snapshot_update 와 같은 기준.
-- 바뀌지 않는 것: 기존 orders·products·memberships·결제 데이터, 기존 트리거, RLS 정책, 횟수/금액 검증.
-- 영향: 이미 만들어진 주문은 그대로(UPDATE 검증 없음). 적용 후 "사이즈 정보가 어긋난 새 주문"만 거부된다. 앱의 정상 흐름(사이즈 선택 후 주문)은 영향 없음.
-- 적용 전 확인(읽기): 아래 파일 하단 주석의 "사전 점검 쿼리" — 최근 주문 중 사이즈가 어긋난 건수.
-- 되돌리기: rollback_add_orders_selected_size_validation_20261109_proposed.sql / 확인: verify_add_orders_selected_size_validation_20261109_proposed.sql
-- ============================================================
BEGIN;

do $$
begin
  if to_regclass('public.orders') is null or to_regclass('public.products') is null then
    raise exception '주문 사이즈 검증: orders/products 테이블이 없습니다 — 중단';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='sizes' and data_type='ARRAY') then
    raise exception '주문 사이즈 검증: products.sizes(text[]) 가 없습니다 — add_product_extras.sql 먼저';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='selected_size') then
    raise exception '주문 사이즈 검증: orders.selected_size 가 없습니다 — 중단';
  end if;
  if to_regprocedure('public.orders_snapshot_product_amount()') is null then
    raise exception '주문 사이즈 검증: orders_snapshot_product_amount() 가 없습니다(add_selectable_count_pricing.sql 미적용) — 중단';
  end if;
end $$;

create or replace function public.orders_validate_selected_size()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sizes text[];
  v_size  text := nullif(btrim(coalesce(new.selected_size, '')), '');
begin
  if auth.uid() is null or new.product_id is null then
    return new;   -- 서버 경로/service_role/cron 은 대상 아님, FK 가 product_id 를 처리
  end if;
  select sizes into v_sizes from products where id = new.product_id;
  if not found then
    return new;
  end if;
  if coalesce(cardinality(v_sizes), 0) > 0 then
    if v_size is null then
      raise exception '사이즈를 선택해주세요';
    end if;
    if not (v_size = any (v_sizes)) then
      raise exception '선택할 수 없는 사이즈예요(%)', v_size;
    end if;
  elsif v_size is not null then
    raise exception '이 상품은 사이즈를 선택할 수 없어요';
  end if;
  return new;
end;
$$;
revoke all on function public.orders_validate_selected_size() from public, anon, authenticated;

drop trigger if exists orders_validate_selected_size on public.orders;
create trigger orders_validate_selected_size
  before insert on public.orders
  for each row execute function public.orders_validate_selected_size();

COMMIT;

-- (읽기 전용) 사전 점검 쿼리 — 적용 전에 SQL Editor 에서 실행해 영향 범위를 본다:
--   select count(*) filter (where coalesce(cardinality(p.sizes),0) > 0 and nullif(btrim(coalesce(o.selected_size,'')),'') is null)                              as 사이즈필수인데_없음,
--          count(*) filter (where coalesce(cardinality(p.sizes),0) > 0 and o.selected_size is not null and not (o.selected_size = any (p.sizes)))              as 상품에_없는_사이즈,
--          count(*) filter (where coalesce(cardinality(p.sizes),0) = 0 and nullif(btrim(coalesce(o.selected_size,'')),'') is not null)                         as 사이즈없는_상품에_값
--     from orders o join products p on p.id = o.product_id where o.created_at > now() - interval '90 days';
--   (0 이 아니면 어떤 경로가 어긋난 주문을 만들었는지 먼저 확인한다. 이 SQL 은 새 INSERT 만 막으며 기존 행은 건드리지 않는다.)
