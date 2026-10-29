-- 읽기 전용 진단 (DDL/DML 없음, 개인정보·키 미출력). 운영 DB에서 사용자가 직접 실행해 "PG 출처가 불명확한 거래"를 식별한다.
-- 이 결과는 참고용이다 — 주문↔결제 자동 연결/백필은 하지 않는다. 연결 여부는 PG 콘솔(Toss)에서 거래를 확인한 운영자가 판단한다.

-- A) 결제 기록이 하나도 연결되지 않은 PG 완료 주문(고아 PG 주문)
select o.id as order_id, o.payment_provider, o.status, o.amount, o.created_at, o.paid_at, o.profile_id, o.center_id, o.product_id
from orders o
where o.payment_provider is not null and o.payment_provider <> 'mock' and o.status = 'done'
  and not exists (select 1 from payments p where p.order_id = o.id)
order by o.created_at;

-- B) order_id 가 없는데 PG 흔적(provider 또는 pg_transaction_id)이 있는 매출 기록
select p.id as payment_id, p.membership_id, p.profile_id, p.center_id, p.sale_type, p.total_amount, p.payment_provider,
       (p.pg_transaction_id is not null) as has_pg_transaction_id, p.paid_at
from payments p
where p.order_id is null and p.sale_type is distinct from 'refund'
  and ((p.payment_provider is not null and p.payment_provider <> 'mock') or (p.pg_transaction_id is not null and p.pg_transaction_id not like 'mock!_%' escape '!'))
order by p.paid_at;

-- C) A의 주문과 같은 회원·센터·상품의 수강권과 매출/환불 기록 (후보 확인용 표시일 뿐, 연결하지 않음)
select o.id as orphan_order_id, o.amount as order_amount, m.id as membership_id, m.status as membership_status,
       p.id as payment_id, p.sale_type, p.total_amount, p.order_id as payment_order_id, p.paid_at
from orders o
join memberships m on m.profile_id = o.profile_id and m.center_id = o.center_id and m.product_id = o.product_id
left join payments p on p.membership_id = m.id
where o.payment_provider is not null and o.payment_provider <> 'mock' and o.status = 'done'
  and not exists (select 1 from payments px where px.order_id = o.id)
order by o.created_at, m.created_at nulls last, p.paid_at;

-- D) 요약
select count(*) filter (where o.status = 'done' and o.payment_provider is not null and o.payment_provider <> 'mock') as pg_done_orders,
       count(*) filter (where o.status = 'done' and o.payment_provider is not null and o.payment_provider <> 'mock'
                          and not exists (select 1 from payments p where p.order_id = o.id)) as pg_done_orders_without_payment
from orders o;
