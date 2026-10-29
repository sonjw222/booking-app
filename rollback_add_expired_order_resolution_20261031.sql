-- add_expired_order_resolution_20261031.sql 되돌리기: fulfill_order 를 적용 전 정의로 복원하고 RPC 를 삭제한다.
-- 처리 이력 테이블(order_expiry_resolutions)은 기록이 하나라도 있으면 "남긴다"(미수납 취소·환불 예정/완료·기간 조정 이력 보존). 비어 있을 때만 삭제.
-- ⚠ 환불 예정(refund_planned)으로 기록된 주문이 남아 있는 채 롤백하면 그 주문은 fulfill_order 로 발급될 수 있게 된다 — 먼저 환불 예정 주문을 처리(환불 완료 확인)하거나 취소하세요(아래에서 중단).
begin;
do $$
declare v_def text; v_new text; v_h text; v_planned int;
begin
    if to_regclass('public.order_expiry_resolutions') is not null then
        execute 'select count(*) from public.order_expiry_resolutions where resolution = ''refund_planned''' into v_planned;
        if v_planned > 0 then raise exception '롤백 중단: 환불 예정으로 기록된 주문이 %건 남아 있어요 — 환불 완료 확인 또는 취소 후 다시 실행하세요', v_planned; end if;
    end if;
    v_def := pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure); v_h := md5(v_def);
    if v_h = 'b675acdd9c48bba4b4a80891cbba0a76' then raise notice 'fulfill_order: 이미 적용 전 정의 — 건너뜀';
    elsif v_h <> '18c4bb13b1b1f812b6dbef882f0ce068' then raise exception 'fulfill_order 현재 정의가 이 파일 적용본이 아니에요(해시 %) — 덮어쓰지 않고 중단합니다', v_h;
    else
        v_new := replace(v_def, chr(10) ||
'    -- expired_order_guard begin (2026-10-31)' || chr(10) ||
'    if v_order.product_id is not null' || chr(10) ||
'       and coalesce((select fixed_expiry_passed(p.expiry_mode, p.expiry_date) from products p where p.id = v_order.product_id), false)' || chr(10) ||
'       and coalesce(current_setting(''app.expired_order_resolution'', true), '''') <> p_order_id::text then' || chr(10) ||
'        raise exception ''판매 기간이 지난 상품의 주문이에요. 주문 관리의 "만료 상품 주문 처리"에서 수납 여부를 확인해 처리해주세요.'';' || chr(10) ||
'    end if;' || chr(10) ||
'    if exists (select 1 from order_expiry_resolutions r where r.order_id = p_order_id) then' || chr(10) ||
'        raise exception ''만료 상품 주문 처리(미수납 취소/환불)가 기록된 주문은 발급할 수 없어요'';' || chr(10) ||
'    end if;' || chr(10) ||
'    -- expired_order_guard end', '');
        v_new := replace(v_new,
'if coalesce(current_setting(''app.expired_order_resolution'', true), '''') = p_order_id::text then' || chr(10) ||
'        v_expires := nullif(current_setting(''app.expired_order_new_expiry'', true), '''')::date;   -- 만료 상품 주문 처리(이용기간 조정): 이 주문의 수강권에만 적용' || chr(10) ||
'    end if;' || chr(10) ||
'    insert into memberships (', 'insert into memberships (');
        execute v_new;
        if md5(pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure)) <> 'b675acdd9c48bba4b4a80891cbba0a76' then
            raise exception 'fulfill_order 복원 결과 해시가 적용 전 운영 정의와 달라요 — 트랜잭션 전체를 롤백합니다';
        end if;
    end if;
end $$;
drop function if exists public.manager_resolve_expired_order(uuid, text, text, integer, date, text, date, date);
do $$
begin
    if to_regclass('public.order_expiry_resolutions') is not null then
        if (select count(*) from public.order_expiry_resolutions) = 0 then drop table public.order_expiry_resolutions;
        else raise notice 'order_expiry_resolutions 에 처리 이력이 있어 테이블은 남겼어요(이력 보존)'; end if;
    end if;
end $$;
commit;
