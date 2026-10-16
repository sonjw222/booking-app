-- ============================================================
-- NICEPAY provider 지원 DB 기반(2026-10-16, Batch 3 보완판) — 검토용 초안, DEV/Production 미실행.
--
-- 선행: fix_refund_block_all_pg_providers_20261016.sql (nicepay 주문이 생기기 전에 일반 환불 차단이 허용 목록이어야 한다).
-- 순서: ① fix_refund_block_all_pg_providers_20261016.sql → ② 이 파일 → ③ verify_* (읽기 전용).
-- 롤백: rollback_add_nicepay_provider_support_20261016.sql.
--
-- [Batch 3 보완 — 운영 DB 실측 반영]
--  · orders_guard_status_transition()은 pending→paid/done/cancelled, paid→done/cancelled만 허용한다(fix_order_point_lifecycle.sql).
--    'approving'을 쓰려면 이 트리거 확장이 반드시 필요하다 → [3]에서 확장(기존 전이는 그대로, NICEPAY 전이만 추가).
--  · _issue_membership_and_record_payment()는 payments INSERT에 payment_provider를 넣지 않는다 → [6]에서 NICEPAY 주문만 'nicepay'를 기록하도록 제자리 패치
--    (toss/portone/mock/직접결제 기록은 지금과 똑같이 NULL, 과거 데이터는 일절 수정하지 않는다).
--  · admin_center_settlement_summary()는 payment_provider in ('toss','portone')만 정산 대상으로 본다 → 'nicepay' 포함(제자리 패치).
--  · fulfill_order()(센터 직접결제 수동 발급)는 provider를 보지 않아 매니저가 결제 전 NICEPAY 주문을 발급할 수 있다 → NICEPAY 주문 거부(제자리 패치).
--
-- 제자리 패치 방식: 이 파일은 라이브 함수 정의를 통째로 덮어쓰지 않는다. pg_get_functiondef()로 현재 정의를 읽어 정확히 1곳만 문자열 치환하고,
--   예상 위치를 찾지 못하거나 2곳 이상이면(= 라이브가 저장소 계보와 다름) 예외로 중단해 아무것도 바꾸지 않는다. 이미 패치돼 있으면 건너뛴다(멱등).
--
-- 이 파일이 하는 일(기존 값/데이터는 지우거나 바꾸지 않는다):
--  [1] orders / payments 의 payment_provider CHECK에 'nicepay' 추가('mock','toss','portone' 유지)
--  [2] orders.status CHECK에 'approving' 추가 + 서버 전용 컬럼 5개(pg_claim_id, pg_claimed_at, pg_tid(유일), pg_review_reason, pg_review_at)
--  [3] 상태 전이 트리거 확장: approving 진입/이탈과 NICEPAY 주문의 paid/done 전이는 NICEPAY 서버 함수(트랜잭션 로컬 표시 app.nicepay_write) 안에서만 가능
--  [4] 트리거 orders_guard_pg_state: 로그인 사용자는 pg_* 컬럼·approving 진입/이탈·NICEPAY 주문의 provider 변경 불가
--  [5] 감사 테이블 nicepay_review_actions(추가 전용, service_role만 접근) — 모든 선점 해제/검토 표시/수동 해소/수동 확정을 증거와 함께 기록
--  [6] 제자리 패치 3건(발급 helper의 payments.payment_provider, 정산 요약, fulfill_order의 NICEPAY 거부)
--  [7] service_role 전용 RPC 8개
--
-- confirm_real_payment / cancel_real_payment 는 수정하지 않는다(toss/portone 전용 유지, NICEPAY 주문에는 거부).
-- NICEPAY 확정은 confirm_nicepay_payment로만: provider·status=approving·claim 일치·금액·TID 유일·(검토 대기면 수동 확정 함수 경유)·결제기록 provider 일치 사후검증.
-- DB는 PG 응답을 직접 검증할 수 없다 → 서버 라우트가 서명/MID/금액/Moid/TID를 검증한 뒤에만 service_role로 호출하는 신뢰 경계다.
-- 수동 해소의 "증거"는 운영자가 제공한 값(DB가 사실 여부를 검증할 수는 없음)이며, 누가/언제/무엇을 근거로 했는지가 변경 불가 기록으로 남는다.
-- create_order_secure: 저장소에 정의가 없어 건드리지 않는다(docs/payments/NICEPAY_DB_SAFETY_DESIGN_20261016.md §3).
-- 락: ADD CONSTRAINT가 orders/payments 전체 검증 동안 짧게 테이블 락을 잡는다(점검 시간대 권장).
-- ============================================================
begin;

-- [0] 사전 점검: 라이브 정의가 예상(저장소 계보)과 같은지. 다르면 아무것도 바꾸지 않고 중단.
do $$
declare
    v_def text;
begin
    select pg_get_functiondef('public.orders_guard_status_transition()'::regprocedure) into v_def;
    if v_def not like '%허용되지 않는 주문 상태 변경이에요%' then
        raise exception '라이브 orders_guard_status_transition 정의가 예상과 달라요 — 중단';
    end if;
    if v_def like '%approving%' then
        raise notice 'orders_guard_status_transition 이 이미 approving을 포함 — 확장 단계 건너뜀 여부는 [3]에서 판단';
    end if;
end $$;

-- [1] provider CHECK ------------------------------------------------------
alter table orders drop constraint if exists orders_payment_provider_check;
alter table orders add constraint orders_payment_provider_check
    check (payment_provider is null or payment_provider in ('mock', 'toss', 'portone', 'nicepay'));

alter table payments drop constraint if exists payments_payment_provider_check;
alter table payments add constraint payments_payment_provider_check
    check (payment_provider is null or payment_provider in ('mock', 'toss', 'portone', 'nicepay'));

-- [2] status CHECK + 서버 전용 컬럼 ---------------------------------------
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
    check (status in ('pending', 'paid', 'cancelled', 'done', 'approving'));

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

-- [3] 상태 전이 트리거 확장 ------------------------------------------------
-- 기존 규칙(그대로): 같은 상태 통과 / cancelled·done 종료 / pending→paid·done·cancelled / paid→done·cancelled.
-- 추가 규칙: approving 진입·이탈, 그리고 NICEPAY 주문의 paid·done 전이는 NICEPAY 서버 함수가 세운 표시(app.nicepay_write='on') 안에서만.
--   허용 전이(표시 있을 때, provider='nicepay'만): pending→approving, approving→pending, approving→cancelled, approving→paid(pg_tid 필수), paid→done.
--   표시 없이 허용되는 NICEPAY 전이: pending→cancelled 하나뿐(기존 회원 본인 취소/매니저 취소 경로 유지).
create or replace function orders_guard_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_nicepay_write boolean := coalesce(current_setting('app.nicepay_write', true), '') = 'on';
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

    if new.status = 'approving' or old.status = 'approving' or new.payment_provider = 'nicepay' then
        if not v_nicepay_write then
            if new.payment_provider = 'nicepay' and old.status = 'pending' and new.status = 'cancelled' then
                return new;
            end if;
            raise exception 'NICEPAY 주문의 결제 상태는 서버 승인 처리로만 바꿀 수 있어요' using errcode = '42501';
        end if;
        if new.payment_provider is distinct from 'nicepay' then
            raise exception 'approving 상태는 NICEPAY 주문에만 사용할 수 있어요' using errcode = '42501';
        end if;
        if old.status = 'pending' and new.status = 'approving' then return new; end if;
        if old.status = 'approving' and new.status in ('pending', 'cancelled') then return new; end if;
        if old.status = 'approving' and new.status = 'paid' and new.pg_tid is not null and new.pg_claim_id is not null then return new; end if;
        if old.status = 'paid' and new.status = 'done' then return new; end if;
        raise exception '허용되지 않는 주문 상태 변경이에요(% → %)', old.status, new.status;
    end if;

    -- 명시적 허용 전이(Mock/토스/포트원/직접결제 — 기존과 동일)
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
-- 트리거(before update of status)는 기존 것을 그대로 쓴다(함수만 교체).

-- [4] 로그인 사용자 보호 트리거 --------------------------------------------
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
    if new.payment_provider is distinct from old.payment_provider and (old.payment_provider = 'nicepay' or new.payment_provider = 'nicepay') then
        raise exception '결제 사업자는 바꿀 수 없어요' using errcode = '42501';
    end if;
    return new;
end;
$$;
revoke all on function orders_guard_pg_state() from public, anon, authenticated;

drop trigger if exists orders_guard_pg_state on orders;
create trigger orders_guard_pg_state
    before insert or update on orders
    for each row execute function orders_guard_pg_state();

-- [5] 감사 기록(추가 전용) --------------------------------------------------
create table if not exists nicepay_review_actions (
    id              bigint generated always as identity primary key,
    order_id        uuid not null references orders(id) on delete restrict,
    claim_id        uuid,
    action          text not null check (action in ('release', 'mark_review', 'resolve_release', 'resolve_cancel', 'resolve_confirm')),
    evidence_type   text not null,
    evidence_ref    text,
    actor           text not null check (length(btrim(actor)) >= 2),
    note            text,
    tid             text,
    status_before   text,
    status_after    text,
    created_at      timestamptz not null default now()
);
create index if not exists nicepay_review_actions_order_idx on nicepay_review_actions (order_id, created_at);
alter table nicepay_review_actions enable row level security;   -- 정책 없음 = anon/authenticated 접근 불가, service_role(bypassrls)만
revoke all on table nicepay_review_actions from public, anon, authenticated;

create or replace function nicepay_review_actions_append_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    raise exception '감사 기록은 수정하거나 삭제할 수 없어요' using errcode = '42501';
end;
$$;
revoke all on function nicepay_review_actions_append_only() from public, anon, authenticated;
drop trigger if exists nicepay_review_actions_append_only on nicepay_review_actions;
create trigger nicepay_review_actions_append_only
    before update or delete on nicepay_review_actions
    for each row execute function nicepay_review_actions_append_only();

-- [6] 제자리 패치 -----------------------------------------------------------
-- 6-1) 발급 helper: NICEPAY 주문의 payments 행에 payment_provider='nicepay' 기록(그 밖의 모든 주문은 지금처럼 컬럼을 비워 NULL 유지)
do $$
declare
    v_def text; v_new text;
    a1 text := E'total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo\n    ) values (';
    b1 text := E'total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo, payment_provider\n    ) values (';
    a2 text := E'        p_memo\n    );';
    b2 text := E'        p_memo,\n        case when p_order.payment_provider = ''nicepay'' then ''nicepay'' else null end\n    );';
begin
    select pg_get_functiondef('public._issue_membership_and_record_payment(orders,text,text)'::regprocedure) into v_def;
    if v_def like '%case when p_order.payment_provider = ''nicepay'' then ''nicepay'' else null end%' then
        raise notice '_issue_membership_and_record_payment: 이미 패치됨 — 건너뜀';
    else
        if (length(v_def) - length(replace(v_def, a1, ''))) / length(a1) <> 1 or (length(v_def) - length(replace(v_def, a2, ''))) / length(a2) <> 1 then
            raise exception '_issue_membership_and_record_payment 정의가 예상과 달라요(패치 위치 불일치) — 중단';
        end if;
        v_new := replace(replace(v_def, a1, b1), a2, b2);
        execute v_new;
    end if;
end $$;

-- 6-2) 정산 요약: nicepay 결제도 대표(플랫폼) 가맹점 수납 건이므로 정산 대상에 포함. 함수가 없으면 건너뜀(라이브에 미적용일 수 있음).
do $$
declare
    v_def text;
    a text := 'p.payment_provider in (''toss'', ''portone'')';
    b text := 'p.payment_provider in (''toss'', ''portone'', ''nicepay'')';
begin
    if to_regprocedure('public.admin_center_settlement_summary(date,date)') is null then
        raise notice 'admin_center_settlement_summary 없음 — 건너뜀';
        return;
    end if;
    select pg_get_functiondef('public.admin_center_settlement_summary(date,date)'::regprocedure) into v_def;
    if v_def like '%''portone'', ''nicepay''%' then
        raise notice 'admin_center_settlement_summary: 이미 패치됨 — 건너뜀';
    else
        if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then
            raise exception 'admin_center_settlement_summary 정의가 예상과 달라요(패치 위치 불일치) — 중단';
        end if;
        execute replace(v_def, a, b);
    end if;
end $$;

-- 6-3) 센터 직접결제 수동 발급(fulfill_order): PG 승인 전 NICEPAY 주문은 발급 불가(이미 done이면 기존처럼 멱등 응답)
do $$
declare
    v_def text;
    a text := E'    -- [NEW 2026-10-02] 취소된 주문은 다시 발급할 수 없다';
    b text := E'    if v_order.payment_provider = ''nicepay'' then\n        raise exception ''NICEPAY 결제 주문은 PG 승인으로만 발급할 수 있어요'';\n    end if;\n\n' || E'    -- [NEW 2026-10-02] 취소된 주문은 다시 발급할 수 없다';
begin
    select pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure) into v_def;
    if v_def like '%NICEPAY 결제 주문은 PG 승인으로만 발급할 수 있어요%' then
        raise notice 'fulfill_order: 이미 패치됨 — 건너뜀';
    else
        if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then
            raise exception 'fulfill_order 정의가 예상과 달라요(패치 위치 불일치) — 중단';
        end if;
        execute replace(v_def, a, b);
    end if;
end $$;

-- [7] 서버 RPC (service_role 전용). 상태를 바꾸는 함수는 트랜잭션 로컬 표시 app.nicepay_write 를 세워 [3] 트리거를 통과한다.
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

-- pending → approving 원자 선점. 성공하면 claim id(fencing 값), 이미 선점/완료/취소/검토 대기이면 null.
create or replace function nicepay_claim_order(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_claim uuid;
begin
    perform set_config('app.nicepay_write', 'on', true);
    update orders
       set status = 'approving', pg_claim_id = gen_random_uuid(), pg_claimed_at = now()
     where id = p_order_id and payment_provider = 'nicepay' and status = 'pending'
       and pg_review_at is null and pg_tid is null
    returning pg_claim_id into v_claim;
    perform set_config('app.nicepay_write', '', true);
    return v_claim;
end;
$$;

-- 서버 라우트 전용 자동 복귀: 승인이 확정 거절됐거나(approve_rejected) 망취소 성공이 확인된(netcancel_confirmed) 뒤에만. 근거를 감사 기록에 남긴다.
create or replace function nicepay_release_order(p_order_id uuid, p_claim_id uuid, p_basis text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_n int;
begin
    if p_basis is null or p_basis not in ('approve_rejected', 'netcancel_confirmed') then
        raise exception '복귀 근거가 올바르지 않아요';
    end if;
    perform set_config('app.nicepay_write', 'on', true);
    update orders
       set status = 'pending', pg_claim_id = null, pg_claimed_at = null
     where id = p_order_id and status = 'approving' and pg_claim_id = p_claim_id and pg_tid is null and pg_review_at is null;
    get diagnostics v_n = row_count;
    perform set_config('app.nicepay_write', '', true);
    if v_n = 1 then
        insert into nicepay_review_actions(order_id, claim_id, action, evidence_type, actor, status_before, status_after)
        values (p_order_id, p_claim_id, 'release', p_basis, 'system', 'approving', 'pending');
    end if;
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
    if v_n = 1 then
        insert into nicepay_review_actions(order_id, claim_id, action, evidence_type, actor, status_before, status_after)
        values (p_order_id, p_claim_id, 'mark_review', p_reason, 'system', 'approving', 'approving');
    end if;
    return v_n = 1;
end;
$$;

-- 서버 크래시 등으로 approving에 멈춘 주문을 자동 복귀시키지 않고(돈이 승인됐을 수 있다) 검토 대기로 표시한다. 크론/운영 도구가 호출.
create or replace function nicepay_expire_stale_claims(p_older_than interval default interval '30 minutes')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    v_n int;
begin
    with t as (
        update orders
           set pg_review_reason = 'stale_claim', pg_review_at = now()
         where status = 'approving' and pg_review_at is null and pg_claimed_at < now() - p_older_than
        returning id, pg_claim_id
    ), l as (
        insert into nicepay_review_actions(order_id, claim_id, action, evidence_type, actor, status_before, status_after)
        select id, pg_claim_id, 'mark_review', 'stale_claim', 'system', 'approving', 'approving' from t
        returning 1
    )
    select count(*) into v_n from l;
    return v_n;
end;
$$;

-- 운영자 수동 해소. NICEPAY 가맹점관리자 등에서 "실제 PG 상태"를 확인한 증거 없이는 풀 수 없다.
--   release : p_evidence_type in ('netcancel_confirmed','not_approved_confirmed')              → pending (재시도 허용)
--   cancel  : p_evidence_type in ('netcancel_confirmed','not_approved_confirmed','pg_cancel_confirmed') → cancelled (포인트는 기존 취소 트리거가 복원)
--   p_evidence_ref(예: 망취소/취소 거래번호, 관리자 화면 확인 번호) 4자 이상, p_actor(운영자 식별) 2자 이상 필수. 거래번호가 이미 기록된 주문은 풀 수 없다.
create or replace function nicepay_resolve_review(p_order_id uuid, p_action text, p_evidence_type text, p_evidence_ref text, p_actor text, p_note text default null)
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
    if p_evidence_type is null or p_evidence_type not in ('netcancel_confirmed', 'not_approved_confirmed', 'pg_cancel_confirmed')
       or (p_action = 'release' and p_evidence_type = 'pg_cancel_confirmed') then
        raise exception '처리에 맞는 증거 유형이 필요해요';
    end if;
    if p_evidence_ref is null or length(btrim(p_evidence_ref)) < 4 then
        raise exception '증거 번호(거래번호/확인 번호)를 입력해주세요';
    end if;
    if p_actor is null or length(btrim(p_actor)) < 2 then
        raise exception '처리자를 입력해주세요';
    end if;
    select * into v from orders where id = p_order_id for update;
    if not found then raise exception '주문을 찾을 수 없어요'; end if;
    if v.payment_provider is distinct from 'nicepay' or v.status <> 'approving' or v.pg_review_at is null then
        raise exception '검토 대기 중인 NICEPAY 주문이 아니에요';
    end if;
    if v.pg_tid is not null then
        raise exception '거래번호가 기록된 주문은 수동으로 풀 수 없어요';
    end if;
    insert into nicepay_review_actions(order_id, claim_id, action, evidence_type, evidence_ref, actor, note, status_before, status_after)
    values (p_order_id, v.pg_claim_id, 'resolve_' || p_action, p_evidence_type, btrim(p_evidence_ref), btrim(p_actor), p_note,
            'approving', case p_action when 'release' then 'pending' else 'cancelled' end);
    perform set_config('app.nicepay_write', 'on', true);
    update orders
       set status = case p_action when 'release' then 'pending' else 'cancelled' end,
           pg_claim_id = null, pg_claimed_at = null, pg_review_reason = null, pg_review_at = null
     where id = p_order_id;
    perform set_config('app.nicepay_write', '', true);
    return json_build_object('resolved', p_action);
end;
$$;

-- NICEPAY 결제 확정. 서버가 승인 응답 검증(서명/MID/금액/Moid/TID)을 끝낸 뒤에만 호출해야 한다.
-- 검토 대기(pg_review_at) 주문은 이 함수를 직접 호출할 수 없고 nicepay_confirm_reviewed(증거·감사 기록)를 거쳐야 한다.
create or replace function confirm_nicepay_payment(p_order_id uuid, p_claim_id uuid, p_tid text, p_amount integer)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_order  orders;
    v_result json;
    v_pay    int;
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
    if v_order.pg_review_at is not null and coalesce(current_setting('app.nicepay_review_ok', true), '') <> 'on' then
        raise exception '운영자 확인 대기 중인 주문은 수동 확정 절차로만 확정할 수 있어요';
    end if;
    if v_order.amount is distinct from p_amount then
        raise exception '결제 금액이 주문 금액과 일치하지 않아요';
    end if;

    perform set_config('app.nicepay_write', 'on', true);
    update orders set pg_tid = p_tid where id = p_order_id;   -- 유일 인덱스: 다른 주문이 쓴 거래번호면 여기서 실패(확정 전에 롤백)
    select * into v_order from orders where id = p_order_id;

    v_result := _issue_membership_and_record_payment(v_order, p_tid, '실 결제(nicepay) 자동 발급');

    -- 사후 검증: 이 주문의 결제 기록이 정확히 1건이고 provider/거래번호/금액이 주문과 일치해야 한다(아니면 전체 롤백 = 수강권도 없음).
    select count(*) into v_pay from payments
     where order_id = p_order_id and sale_type = 'new' and payment_provider = 'nicepay' and pg_transaction_id = p_tid and total_amount = v_order.amount;
    if v_pay <> 1 or (select count(*) from payments where order_id = p_order_id and sale_type = 'new') <> 1 then
        raise exception '결제 기록이 주문과 일치하지 않아요(provider/거래번호/금액)';
    end if;
    update orders set pg_review_reason = null, pg_review_at = null where id = p_order_id;
    perform set_config('app.nicepay_write', '', true);
    return (jsonb_build_object('already_done', false) || v_result::jsonb)::json;
end;
$$;

-- 운영자 수동 확정: NICEPAY 가맹점관리자에서 "승인됨"을 확인한 경우(승인 TID 확인). 선점 id는 DB에서 읽고 증거와 함께 감사 기록을 남긴다.
create or replace function nicepay_confirm_reviewed(p_order_id uuid, p_tid text, p_amount integer, p_evidence_ref text, p_actor text, p_note text default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v      orders;
    v_res  json;
begin
    if p_evidence_ref is null or length(btrim(p_evidence_ref)) < 4 then
        raise exception '증거 번호(거래번호/확인 번호)를 입력해주세요';
    end if;
    if p_actor is null or length(btrim(p_actor)) < 2 then
        raise exception '처리자를 입력해주세요';
    end if;
    select * into v from orders where id = p_order_id for update;
    if not found then raise exception '주문을 찾을 수 없어요'; end if;
    if v.payment_provider is distinct from 'nicepay' or v.status <> 'approving' or v.pg_review_at is null then
        raise exception '검토 대기 중인 NICEPAY 주문이 아니에요';
    end if;
    insert into nicepay_review_actions(order_id, claim_id, action, evidence_type, evidence_ref, actor, note, tid, status_before, status_after)
    values (p_order_id, v.pg_claim_id, 'resolve_confirm', 'pg_approved_confirmed', btrim(p_evidence_ref), btrim(p_actor), p_note, p_tid, 'approving', 'done');
    perform set_config('app.nicepay_review_ok', 'on', true);
    v_res := confirm_nicepay_payment(p_order_id, v.pg_claim_id, p_tid, p_amount);
    perform set_config('app.nicepay_review_ok', '', true);
    return v_res;
end;
$$;

revoke all on function nicepay_order_context(uuid) from public, anon, authenticated;
revoke all on function nicepay_claim_order(uuid) from public, anon, authenticated;
revoke all on function nicepay_release_order(uuid, uuid, text) from public, anon, authenticated;
revoke all on function nicepay_mark_review(uuid, uuid, text) from public, anon, authenticated;
revoke all on function nicepay_expire_stale_claims(interval) from public, anon, authenticated;
revoke all on function nicepay_resolve_review(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function confirm_nicepay_payment(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function nicepay_confirm_reviewed(uuid, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function nicepay_order_context(uuid) to service_role;
grant execute on function nicepay_claim_order(uuid) to service_role;
grant execute on function nicepay_release_order(uuid, uuid, text) to service_role;
grant execute on function nicepay_mark_review(uuid, uuid, text) to service_role;
grant execute on function nicepay_expire_stale_claims(interval) to service_role;
grant execute on function nicepay_resolve_review(uuid, text, text, text, text, text) to service_role;
grant execute on function confirm_nicepay_payment(uuid, uuid, text, integer) to service_role;
grant execute on function nicepay_confirm_reviewed(uuid, text, integer, text, text, text) to service_role;
grant select, insert on table nicepay_review_actions to service_role;

commit;
