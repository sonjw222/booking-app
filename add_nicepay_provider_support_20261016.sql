-- ============================================================
-- NICEPAY provider 지원 DB 기반(2026-10-16) — 검토용 초안, DEV/Production 미실행.
--
-- 선행: fix_refund_block_all_pg_providers_20261016.sql (nicepay 주문이 생기기 전에 일반 환불 차단이 허용 목록으로 바뀌어 있어야 한다).
-- 순서: ① fix_refund_block_all_pg_providers_20261016.sql → ② 이 파일. 롤백: rollback_add_nicepay_provider_support_20261016.sql. 검증: verify_add_nicepay_provider_support_20261016.sql(읽기 전용).
--
-- 이 파일이 하는 일(기존 값/데이터는 지우거나 바꾸지 않는다):
--  [1] orders / payments 의 payment_provider CHECK에 'nicepay'를 추가한다. 'mock','toss','portone'은 그대로 유지(과거 거래 호환).
--  [2] orders.status CHECK에 'approving'(NICEPAY 승인 처리 중)을 추가한다. 기존 4개 값은 그대로.
--  [3] orders에 서버 전용 컬럼 5개: pg_claim_id(승인 선점 fencing 값), pg_claimed_at, pg_tid(NICEPAY 거래번호, 유일), pg_review_reason, pg_review_at(운영자 확인 대기).
--  [4] 트리거 orders_guard_pg_state: 로그인 사용자(auth.uid() 있음)는 위 컬럼을 만들거나 바꿀 수 없고, status가 'approving'으로 들어가거나 나올 수도 없다.
--      (기존 RLS "주문 본인 취소"는 status in ('pending','paid')만 허용하므로 승인 중 주문은 회원이 취소할 수 없다 — 승인-취소 경합 차단.)
--  [5] service_role 전용 RPC 6개: nicepay_order_context / nicepay_claim_order / nicepay_release_order / nicepay_mark_review /
--      nicepay_expire_stale_claims / nicepay_resolve_review, 그리고 confirm_nicepay_payment.
--
-- confirm_real_payment / cancel_real_payment 는 이 파일에서 수정하지 않는다 — toss/portone 전용으로 남겨 NICEPAY 주문에는 동작하지 않는다.
--   NICEPAY는 별도 함수(confirm_nicepay_payment)로만 확정한다: ① provider='nicepay' ② status='approving' ③ 선점 claim id 일치(오래된 요청이 재선점 후 확정 불가)
--   ④ 금액 일치 ⑤ TID 유일(다른 주문의 거래 재사용 불가) ⑥ service_role만 실행. 실제 NICEPAY 승인 검증(서명/금액/MID)은 서버 라우트(lib/payments/server/nicepay/lifecycle.ts)가
--   이 함수를 부르기 전에 수행해야 한다 — DB는 PG 응답을 직접 검증할 수 없으므로 이 함수는 "서버가 검증을 마쳤다"는 신뢰 경계(service_role) 위에 있다.
-- 수강권 발급은 기존 공통 helper(_issue_membership_and_record_payment: 금액 재검증·쿠폰·포인트·자동예약)를 그대로 호출한다. 이 파일은 그 helper를 바꾸지 않는다.
--
-- create_order_secure: 저장소에 정의가 없고(앱은 orders를 직접 INSERT) 라이브 전용이다. 이 파일은 건드리지 않는다 — 설계/확인 쿼리는
--   docs/payments/NICEPAY_DB_SAFETY_DESIGN_20261016.md 참고.
-- 락: ADD CONSTRAINT는 orders/payments 전체 검증 동안 짧게 테이블 락을 잡는다(소규모 테이블 기준 문제 없음, 점검 시간대 권장).
-- ============================================================
begin;

-- [1] provider CHECK ------------------------------------------------------
alter table orders drop constraint if exists orders_payment_provider_check;
alter table orders add constraint orders_payment_provider_check
    check (payment_provider is null or payment_provider in ('mock', 'toss', 'portone', 'nicepay'));

alter table payments drop constraint if exists payments_payment_provider_check;
alter table payments add constraint payments_payment_provider_check
    check (payment_provider is null or payment_provider in ('mock', 'toss', 'portone', 'nicepay'));

-- [2] status CHECK ---------------------------------------------------------
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
    check (status in ('pending', 'paid', 'cancelled', 'done', 'approving'));

-- [3] 서버 전용 컬럼 -------------------------------------------------------
alter table orders add column if not exists pg_claim_id uuid;
alter table orders add column if not exists pg_claimed_at timestamptz;
alter table orders add column if not exists pg_tid text;
alter table orders add column if not exists pg_review_reason text;
alter table orders add column if not exists pg_review_at timestamptz;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'orders_pg_review_reason_check') then
        alter table orders add constraint orders_pg_review_reason_check
            check (pg_review_reason is null or pg_review_reason in ('netcancel_failed', 'confirm_state_unknown', 'stale_claim'));
    end if;
end $$;

create unique index if not exists orders_pg_tid_unique on orders (pg_tid) where pg_tid is not null;
create index if not exists orders_pg_review_pending_idx on orders (pg_review_at) where pg_review_at is not null;

-- [4] 상태/컬럼 보호 트리거 -----------------------------------------------
create or replace function orders_guard_pg_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    -- service_role/서버 작업은 JWT sub가 없어(auth.uid() null) 통과한다 — 기존 orders_force_server_fields_on_insert와 같은 규칙.
    if auth.uid() is null then
        return new;
    end if;
    if tg_op = 'INSERT' then
        new.pg_claim_id := null; new.pg_claimed_at := null; new.pg_tid := null;
        new.pg_review_reason := null; new.pg_review_at := null;
        if new.status = 'approving' then new.status := 'pending'; end if;
        return new;
    end if;
    if new.pg_claim_id is distinct from old.pg_claim_id or new.pg_claimed_at is distinct from old.pg_claimed_at
       or new.pg_tid is distinct from old.pg_tid or new.pg_review_reason is distinct from old.pg_review_reason
       or new.pg_review_at is distinct from old.pg_review_at then
        raise exception '결제 처리 상태는 서버에서만 변경할 수 있어요' using errcode = '42501';
    end if;
    if (new.status = 'approving') is distinct from (old.status = 'approving') then
        raise exception '결제 승인 중 상태는 서버에서만 변경할 수 있어요' using errcode = '42501';
    end if;
    return new;
end;
$$;
revoke all on function orders_guard_pg_state() from public, anon, authenticated;

drop trigger if exists orders_guard_pg_state on orders;
create trigger orders_guard_pg_state
    before insert or update on orders
    for each row execute function orders_guard_pg_state();

-- [5] 서버 RPC (service_role 전용) -----------------------------------------
create or replace function nicepay_order_context(p_order_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v orders;
begin
    select * into v from orders where id = p_order_id;
    if not found then
        return null;
    end if;
    return json_build_object('orderId', v.id, 'status', v.status, 'amount', v.amount, 'provider', v.payment_provider,
                             'reviewPending', v.pg_review_at is not null);
end;
$$;

-- pending → approving 원자 선점. 성공하면 claim id(fencing 값)를 돌려주고, 이미 선점/완료/취소/검토 대기이면 null.
create or replace function nicepay_claim_order(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_claim uuid;
begin
    update orders
       set status = 'approving', pg_claim_id = gen_random_uuid(), pg_claimed_at = now()
     where id = p_order_id and payment_provider = 'nicepay' and status = 'pending'
       and pg_review_at is null and pg_tid is null
    returning pg_claim_id into v_claim;
    return v_claim;
end;
$$;

-- 승인 전 실패/확정 거절/망취소 성공 후 pending 복귀(재시도 허용). 선점 claim이 일치하고 거래번호가 기록되지 않았으며 검토 대기가 아닐 때만.
create or replace function nicepay_release_order(p_order_id uuid, p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_n int;
begin
    update orders
       set status = 'pending', pg_claim_id = null, pg_claimed_at = null
     where id = p_order_id and status = 'approving' and pg_claim_id = p_claim_id and pg_tid is null and pg_review_at is null;
    get diagnostics v_n = row_count;
    return v_n = 1;
end;
$$;

-- 결과 불명/망취소 실패 → 운영자 확인 대기 표시. 주문은 approving으로 남아 재선점·회원 취소가 모두 막힌다.
create or replace function nicepay_mark_review(p_order_id uuid, p_claim_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_n int;
begin
    if p_reason is null or p_reason not in ('netcancel_failed', 'confirm_state_unknown', 'stale_claim') then
        raise exception '알 수 없는 검토 사유예요';
    end if;
    update orders
       set pg_review_reason = p_reason, pg_review_at = coalesce(pg_review_at, now())
     where id = p_order_id and status = 'approving' and pg_claim_id = p_claim_id;
    get diagnostics v_n = row_count;
    return v_n = 1;
end;
$$;

-- 서버가 크래시해 approving으로 멈춘 주문을 자동 복귀시키지 않고(돈이 승인됐을 수 있다) 검토 대기로 표시한다. 크론/운영 도구가 호출.
create or replace function nicepay_expire_stale_claims(p_older_than interval default interval '30 minutes')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    v_n int;
begin
    update orders
       set pg_review_reason = 'stale_claim', pg_review_at = now()
     where status = 'approving' and pg_review_at is null and pg_claimed_at < now() - p_older_than;
    get diagnostics v_n = row_count;
    return v_n;
end;
$$;

-- 운영자 수동 해소: NICEPAY 가맹점관리자에서 실제 상태를 확인한 뒤 'release'(미승인/망취소됨 → 재시도 가능) 또는 'cancel'(주문 취소)만 가능.
-- 승인된 거래의 수강권 발급은 confirm_nicepay_payment(claim id 일치)로만 한다. 거래번호가 이미 기록된 주문은 이 함수로 풀 수 없다.
create or replace function nicepay_resolve_review(p_order_id uuid, p_action text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v orders;
begin
    if p_action not in ('release', 'cancel') then
        raise exception '지원하지 않는 처리예요';
    end if;
    select * into v from orders where id = p_order_id for update;
    if not found then raise exception '주문을 찾을 수 없어요'; end if;
    if v.payment_provider is distinct from 'nicepay' or v.status <> 'approving' or v.pg_review_at is null then
        raise exception '검토 대기 중인 NICEPAY 주문이 아니에요';
    end if;
    if v.pg_tid is not null then
        raise exception '거래번호가 기록된 주문은 수동으로 풀 수 없어요';
    end if;
    update orders
       set status = case p_action when 'release' then 'pending' else 'cancelled' end,
           pg_claim_id = null, pg_claimed_at = null, pg_review_reason = null, pg_review_at = null
     where id = p_order_id;
    return json_build_object('resolved', p_action);
end;
$$;

-- NICEPAY 결제 확정. 서버가 승인 응답 검증(서명/MID/금액/Moid/TID)을 끝낸 뒤에만 호출해야 한다.
create or replace function confirm_nicepay_payment(p_order_id uuid, p_claim_id uuid, p_tid text, p_amount integer)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_order  orders;
    v_result json;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;
    if v_order.payment_provider is distinct from 'nicepay' then
        raise exception 'NICEPAY 결제 확정은 NICEPAY 주문에만 사용할 수 있어요';
    end if;
    if p_tid is null or btrim(p_tid) = '' or length(p_tid) > 64 then
        raise exception '거래번호가 올바르지 않아요';
    end if;

    -- 멱등: 이미 완료된 주문은 같은 거래번호일 때만 성공으로 돌려준다(다른 거래로 덮어쓰기/중복 발급 없음).
    if v_order.status = 'done' then
        if v_order.pg_tid is distinct from p_tid then
            raise exception '이미 다른 거래로 완료된 주문이에요';
        end if;
        return json_build_object('already_done', true);
    end if;
    if v_order.status <> 'approving' then
        raise exception '승인 처리 중인 주문이 아니에요';
    end if;
    if v_order.pg_claim_id is distinct from p_claim_id then
        raise exception '승인 선점이 일치하지 않아요';
    end if;
    if v_order.amount is distinct from p_amount then
        raise exception '결제 금액이 주문 금액과 일치하지 않아요';
    end if;

    update orders set pg_tid = p_tid where id = p_order_id;   -- 유일 인덱스: 다른 주문이 쓴 거래번호면 여기서 실패(확정 전에 롤백)
    select * into v_order from orders where id = p_order_id;

    v_result := _issue_membership_and_record_payment(v_order, p_tid, '실 결제(nicepay) 자동 발급');

    update orders set pg_review_reason = null, pg_review_at = null where id = p_order_id;
    return (jsonb_build_object('already_done', false) || v_result::jsonb)::json;
end;
$$;

revoke all on function nicepay_order_context(uuid) from public, anon, authenticated;
revoke all on function nicepay_claim_order(uuid) from public, anon, authenticated;
revoke all on function nicepay_release_order(uuid, uuid) from public, anon, authenticated;
revoke all on function nicepay_mark_review(uuid, uuid, text) from public, anon, authenticated;
revoke all on function nicepay_expire_stale_claims(interval) from public, anon, authenticated;
revoke all on function nicepay_resolve_review(uuid, text) from public, anon, authenticated;
revoke all on function confirm_nicepay_payment(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function nicepay_order_context(uuid) to service_role;
grant execute on function nicepay_claim_order(uuid) to service_role;
grant execute on function nicepay_release_order(uuid, uuid) to service_role;
grant execute on function nicepay_mark_review(uuid, uuid, text) to service_role;
grant execute on function nicepay_expire_stale_claims(interval) to service_role;
grant execute on function nicepay_resolve_review(uuid, text) to service_role;
grant execute on function confirm_nicepay_payment(uuid, uuid, text, integer) to service_role;

commit;
