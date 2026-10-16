-- 롤백: add_nicepay_provider_support_20261016.sql 되돌리기. nicepay 주문/approving/pg_* 데이터/감사 기록이 하나라도 있으면 중단한다(데이터·증거 보호).
-- 되돌리는 것: 신규 RPC·트리거·컬럼·인덱스·감사 테이블(비어 있을 때만), 상태 전이 트리거(원래 4전이 정의로), 제자리 패치 3건(발급 helper / 정산 요약 / fulfill_order), CHECK 제약.
begin;

do $$
begin
    if exists (select 1 from orders where payment_provider = 'nicepay' or status = 'approving' or pg_tid is not null or pg_claim_id is not null or pg_review_at is not null)
       or exists (select 1 from payments where payment_provider = 'nicepay')
       or (to_regclass('public.nicepay_review_actions') is not null and exists (select 1 from nicepay_review_actions)) then
        raise exception 'nicepay 관련 주문/결제/감사 데이터가 있어 롤백하지 않습니다(먼저 운영자가 정리/확인하세요)';
    end if;
end $$;

drop function if exists nicepay_confirm_reviewed(uuid, text, integer, text, text, text);
drop function if exists confirm_nicepay_payment(uuid, uuid, text, integer);
drop function if exists nicepay_resolve_review(uuid, text, text, text, text, text);
drop function if exists nicepay_expire_stale_claims(interval);
drop function if exists nicepay_mark_review(uuid, uuid, text);
drop function if exists nicepay_release_order(uuid, uuid, text);
drop function if exists nicepay_claim_order(uuid);
drop function if exists nicepay_order_context(uuid);
drop table if exists nicepay_review_actions;
drop function if exists nicepay_review_actions_append_only();
drop trigger if exists orders_guard_pg_state on orders;
drop function if exists orders_guard_pg_state();

-- 상태 전이 트리거를 원래 정의(pending→paid/done/cancelled, paid→done/cancelled)로 복원(트리거 자체는 그대로)
create or replace function orders_guard_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.status is not distinct from old.status then
        return new;
    end if;
    if old.status = 'cancelled' then
        raise exception '이미 취소된 주문은 다시 처리할 수 없어요';
    end if;
    if old.status = 'done' then
        raise exception '이미 발급된 주문은 상태를 바꿀 수 없어요. 환불은 환불 기능을 이용해주세요';
    end if;
    -- 명시적 허용 전이(Mock/실 결제의 pending→paid→done 흐름과 기존 취소 경로 호환)
    if old.status = 'pending' and new.status in ('paid', 'done', 'cancelled') then
        return new;
    end if;
    if old.status = 'paid' and new.status in ('done', 'cancelled') then
        return new;
    end if;
    raise exception '허용되지 않는 주문 상태 변경이에요(% → %)', old.status, new.status;
end;
$$;
revoke all on function orders_guard_status_transition() from public, anon, authenticated;

-- 제자리 패치 되돌리기(없으면 건너뜀)
do $$
declare
    v_def text;
begin
    select pg_get_functiondef('public._issue_membership_and_record_payment(orders,text,text)'::regprocedure) into v_def;
    v_def := replace(v_def, E'total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo, payment_provider\n    ) values (', E'total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo\n    ) values (');
    v_def := replace(v_def, E'        p_memo,\n        case when p_order.payment_provider = ''nicepay'' then ''nicepay'' else null end\n    );', E'        p_memo\n    );');
    execute v_def;

    if to_regprocedure('public.admin_center_settlement_summary(date,date)') is not null then
        select pg_get_functiondef('public.admin_center_settlement_summary(date,date)'::regprocedure) into v_def;
        execute replace(v_def, 'p.payment_provider in (''toss'', ''portone'', ''nicepay'')', 'p.payment_provider in (''toss'', ''portone'')');
    end if;

    select pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure) into v_def;
    execute replace(v_def, E'    if v_order.payment_provider = ''nicepay'' then\n        raise exception ''NICEPAY 결제 주문은 PG 승인으로만 발급할 수 있어요'';\n    end if;\n\n', '');
end $$;

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
