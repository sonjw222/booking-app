-- ============================================================
-- P2-31 — pass.sale_toggle(수강권 판매정지/재개) 신규 기능
--
-- 배경: products.is_on_sale 컬럼은 schema.sql부터 있었고 구매 가능 목록 필터로
-- 곳곳에서 읽히지만(lib/reservations.ts, lib/passes.ts, lib/center.ts, lib/sales.ts),
-- 이 값을 켜고 끄는 UI/RPC가 지금까지 전혀 없었다(단순 미완성 권한이 아니라 기능
-- 자체가 없던 상태, 2026-09-09 P2-31 조사에서 발견). deleteProduct()의
-- is_active=false(영구 비활성화, 판매 이력 보존용 소프트 삭제)와는 다른 개념 —
-- is_on_sale은 언제든 다시 켤 수 있는 임시 판매정지/재개용이다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create or replace function toggle_product_sale_safe(p_product_id uuid, p_on_sale boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center_id uuid;
begin
    select center_id into v_center_id from products where id = p_product_id;
    if v_center_id is null then
        raise exception '상품을 찾을 수 없어요';
    end if;

    if not (has_permission(v_center_id, 'pass.sale_toggle') or is_platform_admin()) then
        raise exception '판매정지/재개 권한이 없어요';
    end if;

    update products set is_on_sale = p_on_sale where id = p_product_id;
end;
$$;

revoke all on function toggle_product_sale_safe(uuid, boolean) from public;
revoke all on function toggle_product_sale_safe(uuid, boolean) from anon;
grant execute on function toggle_product_sale_safe(uuid, boolean) to authenticated;

-- ============================================================
-- 확인
-- ============================================================
select proname from pg_proc where proname = 'toggle_product_sale_safe';
