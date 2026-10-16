-- 롤백: add_nicepay_provider_support_20261016.sql 되돌리기. nicepay 주문/approving 상태/pg_* 데이터가 하나라도 있으면 중단한다(데이터 보호).
begin;

do $$
begin
    if exists (select 1 from orders where payment_provider = 'nicepay' or status = 'approving' or pg_tid is not null or pg_claim_id is not null or pg_review_at is not null)
       or exists (select 1 from payments where payment_provider = 'nicepay') then
        raise exception 'nicepay 관련 주문/결제 데이터가 있어 롤백하지 않습니다(먼저 운영자가 정리/확인하세요)';
    end if;
end $$;

drop function if exists confirm_nicepay_payment(uuid, uuid, text, integer);
drop function if exists nicepay_resolve_review(uuid, text);
drop function if exists nicepay_expire_stale_claims(interval);
drop function if exists nicepay_mark_review(uuid, uuid, text);
drop function if exists nicepay_release_order(uuid, uuid);
drop function if exists nicepay_claim_order(uuid);
drop function if exists nicepay_order_context(uuid);
drop trigger if exists orders_guard_pg_state on orders;
drop function if exists orders_guard_pg_state();
drop index if exists orders_pg_review_pending_idx;
drop index if exists orders_pg_tid_unique;
alter table orders drop constraint if exists orders_pg_review_reason_check;
alter table orders drop column if exists pg_review_at;
alter table orders drop column if exists pg_review_reason;
alter table orders drop column if exists pg_tid;
alter table orders drop column if exists pg_claimed_at;
alter table orders drop column if exists pg_claim_id;

alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in ('pending', 'paid', 'cancelled', 'done'));
alter table orders drop constraint if exists orders_payment_provider_check;
alter table orders add constraint orders_payment_provider_check check (payment_provider is null or payment_provider in ('mock', 'toss', 'portone'));
alter table payments drop constraint if exists payments_payment_provider_check;
alter table payments add constraint payments_payment_provider_check check (payment_provider is null or payment_provider in ('mock', 'toss', 'portone'));

commit;
