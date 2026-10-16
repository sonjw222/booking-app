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
--  · [운영 실측 반영] 운영 fulfill_order에는 '[NEW 2026-10-02]' 주석이 없고 운영 함수 정의에는 CRLF가 있다 → 모든 패치 위치를 줄바꿈·들여쓰기에 둔감한 정규식 + '정확히 1곳' 검증으로 교체.
--  · NICEPAY 환불은 실제 PG 취소 확인 기록(nicepay_pg_cancels) 없이는 내부 환불 불가([5-2], [6-4]).
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

-- [0] 사전 점검: 라이브 상태 전이 트리거가 예상(기존 4전이)과 같은지. 다르면 아무것도 바꾸지 않고 중단. (공백·줄바꿈(CRLF/LF) 차이는 정규식으로 허용)
do $$
declare
    v_def text;
begin
    select pg_get_functiondef('public.orders_guard_status_transition()'::regprocedure) into v_def;
    if v_def !~ '허용되지 않는 주문 상태 변경이에요'
       or v_def !~ 'old\.status\s*=\s*''pending''\s+and\s+new\.status\s+in\s*\(\s*''paid''\s*,\s*''done''\s*,\s*''cancelled''\s*\)'
       or v_def !~ 'old\.status\s*=\s*''paid''\s+and\s+new\.status\s+in\s*\(\s*''done''\s*,\s*''cancelled''\s*\)' then
        raise exception '라이브 orders_guard_status_transition 정의가 예상(pending→paid/done/cancelled, paid→done/cancelled)과 달라요 — 중단';
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
    approver        text,
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

-- [5-2] 서버가 검증한 PG 승인 기록(추가 전용): NICEPAY 수강권 발급(확정)과 수동 확정은 이 기록이 있어야만 가능하다.
--   운영자가 입력한 증빙 문자열만으로는 수강권을 발급할 수 없게 하는 핵심 장치. 기록은 서버 라우트가 NICEPAY 승인 응답의 서명·MID·금액·Moid·TID를 모두 검증한 직후에만 남긴다.
--   response_digest = 검증한 응답 필드(TID, Moid, Amt, MID, ResultCode, AuthDate)의 sha256(원문/개인정보는 저장하지 않음).
create table if not exists nicepay_pg_approvals (
    id              bigint generated always as identity primary key,
    order_id        uuid not null references orders(id) on delete restrict,
    claim_id        uuid not null,
    tid             text not null unique check (length(btrim(tid)) >= 4),
    amount          integer not null check (amount > 0),
    response_digest text not null check (response_digest ~ '^[0-9a-f]{64}$'),
    created_at      timestamptz not null default now()
);
create index if not exists nicepay_pg_approvals_order_idx on nicepay_pg_approvals (order_id, claim_id);
alter table nicepay_pg_approvals enable row level security;
revoke all on table nicepay_pg_approvals from public, anon, authenticated;
create or replace function nicepay_pg_approvals_append_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    raise exception '승인 기록은 수정하거나 삭제할 수 없어요' using errcode = '42501';
end;
$$;
revoke all on function nicepay_pg_approvals_append_only() from public, anon, authenticated;
drop trigger if exists nicepay_pg_approvals_append_only on nicepay_pg_approvals;
create trigger nicepay_pg_approvals_append_only
    before update or delete on nicepay_pg_approvals
    for each row execute function nicepay_pg_approvals_append_only();

-- [5-3] 실제 PG 승인 취소 확인 기록(추가 전용): NICEPAY 환불·재시도(release)는 서버가 검증한 승인(위 기록)에 대한 이 기록이 있어야 가능하다([6-4]).
--   (order_id, pg_tid)당 1건. api_response = 서버가 취소/망취소 응답을 검증(digest 필수), admin_console = 운영자 확인(2인 승인 필수).
create table if not exists nicepay_pg_cancels (
    id              bigint generated always as identity primary key,
    order_id        uuid not null references orders(id) on delete restrict,
    pg_tid          text not null references nicepay_pg_approvals(tid) on delete restrict,
    cancel_tid      text not null unique check (length(btrim(cancel_tid)) >= 4),
    cancel_amount   integer not null check (cancel_amount > 0),
    source          text not null check (source in ('api_response', 'admin_console')),
    actor           text not null check (length(btrim(actor)) >= 2),
    approver        text check (approver is null or (length(btrim(approver)) >= 2 and btrim(approver) <> btrim(actor))),
    response_digest text check (response_digest is null or response_digest ~ '^[0-9a-f]{64}$'),
    created_at      timestamptz not null default now(),
    unique (order_id, pg_tid),
    check ((source = 'admin_console' and approver is not null) or (source = 'api_response' and response_digest is not null))
);
alter table nicepay_pg_cancels enable row level security;
revoke all on table nicepay_pg_cancels from public, anon, authenticated;
create or replace function nicepay_pg_cancels_append_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    raise exception '취소 확인 기록은 수정하거나 삭제할 수 없어요' using errcode = '42501';
end;
$$;
revoke all on function nicepay_pg_cancels_append_only() from public, anon, authenticated;
drop trigger if exists nicepay_pg_cancels_append_only on nicepay_pg_cancels;
create trigger nicepay_pg_cancels_append_only
    before update or delete on nicepay_pg_cancels
    for each row execute function nicepay_pg_cancels_append_only();

-- 식별 시퀀스는 클라이언트 롤이 건드릴 수 없게 회수(Supabase 기본 권한 대비)
revoke all on sequence nicepay_review_actions_id_seq from public, anon, authenticated;
revoke all on sequence nicepay_pg_approvals_id_seq from public, anon, authenticated;
revoke all on sequence nicepay_pg_cancels_id_seq from public, anon, authenticated;

-- [6] 제자리 패치 4건 -----------------------------------------------------------
-- 모든 패치는 줄바꿈(CRLF/LF)·들여쓰기에 민감하지 않은 정규식으로 위치를 찾고, 위치가 정확히 1곳이 아니면(예상과 다른 함수 구조) 예외로 전체 트랜잭션을 중단한다.
-- 삽입한 코드는 정확히 되돌릴 수 있게 표지 주석(begin/end)으로 감싸거나 역치환 가능한 형태로 넣는다(롤백 SQL이 원문 그대로 복원).
-- 6-1) 발급 helper: NICEPAY 주문의 payments 행에 payment_provider='nicepay' 기록(그 밖의 모든 주문은 지금처럼 컬럼을 비워 NULL 유지)
do $$
declare
    v_def text; v_n1 int; v_n2 int;
    p1 text := '(pg_transaction_id,\s*paid_at,\s*status,\s*memo)(\s*\)\s*values\s*\()';
    p2 text := '(p_memo)(\s*\)\s*;)';
begin
    select pg_get_functiondef('public._issue_membership_and_record_payment(orders,text,text)'::regprocedure) into v_def;
    if v_def ~ 'case when p_order\.payment_provider = ''nicepay''' then
        raise notice '_issue_membership_and_record_payment: 이미 패치됨 — 건너뜀';
        return;
    end if;
    select count(*) into v_n1 from regexp_matches(v_def, p1, 'g');
    select count(*) into v_n2 from regexp_matches(v_def, p2, 'g');
    if v_n1 <> 1 or v_n2 <> 1 or v_def !~* 'insert\s+into\s+payments' then
        raise exception '_issue_membership_and_record_payment 정의가 예상과 달라요(패치 위치 %/% — 각 1곳이어야 함) — 중단', v_n1, v_n2;
    end if;
    v_def := regexp_replace(v_def, p1, '\1, payment_provider\2');
    v_def := regexp_replace(v_def, p2, '\1, case when p_order.payment_provider = ''nicepay'' then ''nicepay'' else null end\2');
    execute v_def;
end $$;

-- 6-2) 정산 요약: nicepay 결제도 대표(플랫폼) 가맹점 수납 건이므로 정산 대상에 포함. 함수가 없으면 건너뜀(라이브에 미적용일 수 있음).
do $$
declare
    v_def text; v_n int;
    p text := '(p\.payment_provider\s+in\s*\(\s*''toss''\s*,\s*''portone'')(\s*\))';
begin
    if to_regprocedure('public.admin_center_settlement_summary(date,date)') is null then
        raise notice 'admin_center_settlement_summary 없음 — 건너뜀';
        return;
    end if;
    select pg_get_functiondef('public.admin_center_settlement_summary(date,date)'::regprocedure) into v_def;
    if v_def ~ '''portone''\s*,\s*''nicepay''' then
        raise notice 'admin_center_settlement_summary: 이미 패치됨 — 건너뜀';
        return;
    end if;
    select count(*) into v_n from regexp_matches(v_def, p, 'g');
    if v_n <> 1 then
        raise exception 'admin_center_settlement_summary 정의가 예상과 달라요(패치 위치 % — 1곳이어야 함) — 중단', v_n;
    end if;
    execute regexp_replace(v_def, p, '\1, ''nicepay''\2');
end $$;

-- 6-3) 센터 직접결제 수동 발급(fulfill_order): PG 승인 전 NICEPAY 주문은 발급 불가.
--   운영 정의 기준 위치: "if v_order.status = 'cancelled' then raise exception '취소된 주문은 발급할 수 없어요'; end if;" 바로 뒤(주석 유무와 무관).
--   done 멱등 처리(이 블록보다 앞)와 cancelled 차단은 그대로이며, 정확히 한 위치에만 표지 주석으로 감싼 블록을 추가한다.
do $$
declare
    v_def text; v_nl text; v_nd int; v_nc int;
    pd text := 'status\s*=\s*''done''\s+then\s+return\s+json_build_object\(\s*''already_done''\s*,\s*true\s*\)\s*;\s*end\s+if;';
    pc text := '(if\s+v_order\.status\s*=\s*''cancelled''\s+then\s+raise\s+exception\s+''취소된 주문은 발급할 수 없어요''\s*;\s*end\s+if;)';
begin
    select pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure) into v_def;
    if v_def like '%-- fulfill_nicepay_guard begin%' then
        raise notice 'fulfill_order: 이미 패치됨 — 건너뜀';
        return;
    end if;
    select count(*) into v_nd from regexp_matches(v_def, pd, 'g');
    select count(*) into v_nc from regexp_matches(v_def, pc, 'g');
    if v_nd <> 1 or v_nc <> 1 or v_def !~ 'v_order\s+orders' then
        raise exception 'fulfill_order 정의가 예상과 달라요(done 처리 %곳 / cancelled 차단 %곳 — 각 1곳이어야 함) — 중단', v_nd, v_nc;
    end if;
    if strpos(v_def, (regexp_match(v_def, pd))[1]) > strpos(v_def, (regexp_match(v_def, pc))[1]) then
        raise exception 'fulfill_order: done 멱등 처리가 cancelled 차단보다 뒤에 있어요 — 중단';
    end if;
    v_nl := case when position(chr(13) || chr(10) in v_def) > 0 then chr(13) || chr(10) else chr(10) end;
    v_def := regexp_replace(v_def, pc,
        '\1' || v_nl || '    -- fulfill_nicepay_guard begin' || v_nl
        || '    if v_order.payment_provider = ''nicepay'' then' || v_nl
        || '        raise exception ''NICEPAY 결제 주문은 PG 승인으로만 발급할 수 있어요'';' || v_nl
        || '    end if;' || v_nl || '    -- fulfill_nicepay_guard end');
    execute v_def;
end $$;

-- 6-4) 환불 core: NICEPAY 결제(금액>0)는 "실제 PG 승인 취소 확인 기록(nicepay_pg_cancels)"이 있어야만 내부 환불 가능 — p_allow_pg=true인 서버 경로도 동일.
--   기존 PG 일반환불 차단(허용 목록) 바로 뒤에 표지 주석 블록을 1곳 추가. 다른 provider·0원 주문은 영향 없음.
do $$
declare
    v_def text; v_n int; v_nl text;
    p text := '(raise\s+exception\s+''카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요''\s*;\s*end\s+if;)';
begin
    select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) into v_def;
    if v_def like '%-- nicepay_pg_cancel_guard begin%' then
        raise notice '_refund_membership_core: 이미 패치됨 — 건너뜀';
        return;
    end if;
    select count(*) into v_n from regexp_matches(v_def, p, 'g');
    if v_n <> 1 or v_def !~ 'v_order_id' or v_def !~ 'v_amount' then
        raise exception '_refund_membership_core 정의가 예상과 달라요(패치 위치 % — 1곳이어야 함) — 중단', v_n;
    end if;
    v_nl := case when position(chr(13) || chr(10) in v_def) > 0 then chr(13) || chr(10) else chr(10) end;
    v_def := regexp_replace(v_def, p,
        '\1' || v_nl || '    -- nicepay_pg_cancel_guard begin' || v_nl
        || '    if v_order_id is not null and v_amount > 0' || v_nl
        || '       and exists (select 1 from orders o where o.id = v_order_id and o.payment_provider = ''nicepay'')' || v_nl
        || '       and not exists (select 1 from nicepay_pg_cancels c join orders o2 on o2.id = c.order_id and o2.pg_tid = c.pg_tid where c.order_id = v_order_id and c.cancel_amount = v_amount) then' || v_nl
        || '        raise exception ''NICEPAY 결제는 PG 승인 취소가 확인된 뒤에만 환불할 수 있어요'';' || v_nl
        || '    end if;' || v_nl || '    -- nicepay_pg_cancel_guard end');
    execute v_def;
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

-- 서버가 검증한 NICEPAY 승인 응답을 기록한다(승인 응답의 서명·MID·금액·Moid·TID 검증을 마친 직후, DB 확정 전에 호출).
create or replace function nicepay_record_verified_approval(p_order_id uuid, p_claim_id uuid, p_tid text, p_amount integer, p_response_digest text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v orders;
    a nicepay_pg_approvals;
begin
    if p_tid is null or length(btrim(p_tid)) < 4 or length(p_tid) > 64 then raise exception '거래번호가 올바르지 않아요'; end if;
    if p_response_digest is null or p_response_digest !~ '^[0-9a-f]{64}$' then raise exception '승인 응답 요약값이 올바르지 않아요'; end if;
    select * into v from orders where id = p_order_id for update;
    if not found then raise exception '주문을 찾을 수 없어요'; end if;
    if v.payment_provider is distinct from 'nicepay' then raise exception 'NICEPAY 주문이 아니에요'; end if;
    if v.status <> 'approving' or v.pg_claim_id is distinct from p_claim_id then raise exception '승인 선점이 일치하지 않아요'; end if;
    if v.amount is distinct from p_amount then raise exception '결제 금액이 주문 금액과 일치하지 않아요'; end if;
    select * into a from nicepay_pg_approvals where tid = p_tid;
    if found then
        if a.order_id = p_order_id and a.claim_id = p_claim_id and a.amount = p_amount then return json_build_object('already_recorded', true); end if;
        raise exception '이미 다른 주문/선점에 기록된 거래번호예요';
    end if;
    insert into nicepay_pg_approvals(order_id, claim_id, tid, amount, response_digest) values (p_order_id, p_claim_id, p_tid, p_amount, p_response_digest);
    return json_build_object('already_recorded', false);
end;
$$;

-- 서버 라우트 전용 자동 복귀. 승인이 확정 거절됐거나(approve_rejected) 망취소 성공이 확인된(netcancel_confirmed) 뒤에만.
-- 동시성: 승인 기록 저장(nicepay_record_verified_approval)·확정·수동 해소와 같은 순서로 **주문 행을 먼저 FOR UPDATE로 잠근 뒤** 현재 상태(claim_id·status 등)를 다시 검증하고,
--   같은 트랜잭션에서 승인·취소 기록을 확인한다. (잠그기 전에 기록을 조회하면, 조회 직후 다른 트랜잭션이 승인 기록을 커밋해도 이 함수가 그 기록을 못 본 채 선점을 풀 수 있다.)
-- 이 선점에 대해 서버가 검증한 승인 기록이 있으면(= PG에서 돈이 승인됐던 거래) 그 거래의 PG 취소 확인 기록이 있어야만 복귀한다(없으면 false → 호출자는 검토 대기로 표시).
create or replace function nicepay_release_order(p_order_id uuid, p_claim_id uuid, p_basis text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v     orders;
    v_n   int;
begin
    if p_basis is null or p_basis not in ('approve_rejected', 'netcancel_confirmed') then
        raise exception '복귀 근거가 올바르지 않아요';
    end if;
    -- 1) 주문 행 잠금 (이후의 모든 판단은 잠금 획득 뒤의 최신 커밋 상태 기준)
    select * into v from orders where id = p_order_id for update;
    if not found then
        return false;
    end if;
    -- 2) 잠금 후 재검증: NICEPAY 주문 / 승인 중 / 같은 선점 / 거래번호 미기록 / 운영자 확인 대기 아님
    if v.payment_provider is distinct from 'nicepay' or v.status <> 'approving' or v.pg_claim_id is distinct from p_claim_id
       or v.pg_tid is not null or v.pg_review_at is not null then
        return false;
    end if;
    -- 3) 같은 트랜잭션에서 승인·취소 기록 재확인: 취소가 확인되지 않은 승인 기록이 있으면 거부
    if exists (select 1 from nicepay_pg_approvals a where a.order_id = v.id and a.claim_id = p_claim_id
                 and not exists (select 1 from nicepay_pg_cancels c where c.order_id = a.order_id and c.pg_tid = a.tid)) then
        return false;
    end if;
    perform set_config('app.nicepay_write', 'on', true);
    update orders
       set status = 'pending', pg_claim_id = null, pg_claimed_at = null
     where id = v.id and status = 'approving' and pg_claim_id = p_claim_id and pg_tid is null and pg_review_at is null;
    get diagnostics v_n = row_count;
    perform set_config('app.nicepay_write', '', true);
    if v_n = 1 then
        insert into nicepay_review_actions(order_id, claim_id, action, evidence_type, actor, status_before, status_after)
        values (v.id, p_claim_id, 'release', p_basis, 'system', 'approving', 'pending');
    end if;
    return v_n = 1;
end;
$$;

-- 운영자 수동 해소(2인 승인). 증빙 문자열만으로는 아무 것도 발급/환불되지 않는다: 이 함수는 주문을 pending/cancelled로만 되돌릴 수 있고(수강권·환불 없음),
-- 서버가 검증한 승인 기록이 있는 주문은 그 거래의 PG 취소 확인 기록이 있어야만 풀 수 있다.
create or replace function nicepay_resolve_review(p_order_id uuid, p_action text, p_evidence_type text, p_evidence_ref text, p_actor text, p_approver text, p_note text default null)
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
    if p_approver is null or length(btrim(p_approver)) < 2 or btrim(p_approver) = btrim(p_actor) then
        raise exception '처리자와 다른 승인자가 필요해요(2인 승인)';
    end if;
    select * into v from orders where id = p_order_id for update;
    if not found then raise exception '주문을 찾을 수 없어요'; end if;
    if v.payment_provider is distinct from 'nicepay' or v.status <> 'approving' or v.pg_review_at is null then
        raise exception '검토 대기 중인 NICEPAY 주문이 아니에요';
    end if;
    if v.pg_tid is not null then
        raise exception '거래번호가 기록된 주문은 수동으로 풀 수 없어요';
    end if;
    if exists (select 1 from nicepay_pg_approvals a where a.order_id = p_order_id and a.claim_id = v.pg_claim_id
                 and not exists (select 1 from nicepay_pg_cancels c where c.order_id = a.order_id and c.pg_tid = a.tid)) then
        raise exception '서버가 검증한 PG 승인이 있는 주문은 PG 취소 확인 기록 뒤에만 풀 수 있어요';
    end if;
    insert into nicepay_review_actions(order_id, claim_id, action, evidence_type, evidence_ref, actor, approver, note, status_before, status_after)
    values (p_order_id, v.pg_claim_id, 'resolve_' || p_action, p_evidence_type, btrim(p_evidence_ref), btrim(p_actor), btrim(p_approver), p_note,
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

-- NICEPAY 결제 확정. 서버가 승인 응답 검증을 끝내고 nicepay_record_verified_approval 로 기록한 뒤에만 호출해야 한다.
-- 서버가 검증한 승인 기록(주문·선점·TID·금액 일치)이 없으면 확정할 수 없다 — 호출자가 임의의 TID/금액을 넘겨도 수강권이 발급되지 않는다.
-- 검토 대기(pg_review_at) 주문은 이 함수를 직접 호출할 수 없고 nicepay_confirm_reviewed(증거·2인 승인·감사 기록)를 거쳐야 한다.
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
    if not exists (select 1 from nicepay_pg_approvals a where a.order_id = p_order_id and a.claim_id = p_claim_id and a.tid = p_tid and a.amount = p_amount) then
        raise exception '서버가 검증한 PG 승인 기록이 없어요';
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

-- 운영자 수동 확정(2인 승인): 서버가 검증한 승인 기록(해당 선점·TID·금액)이 있는 검토 대기 주문에서만. 증빙 문자열만으로는 확정되지 않는다.
create or replace function nicepay_confirm_reviewed(p_order_id uuid, p_tid text, p_amount integer, p_evidence_ref text, p_actor text, p_approver text, p_note text default null)
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
    if p_approver is null or length(btrim(p_approver)) < 2 or btrim(p_approver) = btrim(p_actor) then
        raise exception '처리자와 다른 승인자가 필요해요(2인 승인)';
    end if;
    select * into v from orders where id = p_order_id for update;
    if not found then raise exception '주문을 찾을 수 없어요'; end if;
    if v.payment_provider is distinct from 'nicepay' or v.status <> 'approving' or v.pg_review_at is null then
        raise exception '검토 대기 중인 NICEPAY 주문이 아니에요';
    end if;
    if not exists (select 1 from nicepay_pg_approvals a where a.order_id = p_order_id and a.claim_id = v.pg_claim_id and a.tid = p_tid and a.amount = p_amount) then
        raise exception '서버가 검증한 PG 승인 기록이 없는 거래는 수동 확정할 수 없어요';
    end if;
    insert into nicepay_review_actions(order_id, claim_id, action, evidence_type, evidence_ref, actor, approver, note, tid, status_before, status_after)
    values (p_order_id, v.pg_claim_id, 'resolve_confirm', 'pg_approved_confirmed', btrim(p_evidence_ref), btrim(p_actor), btrim(p_approver), p_note, p_tid, 'approving', 'done');
    perform set_config('app.nicepay_review_ok', 'on', true);
    v_res := confirm_nicepay_payment(p_order_id, v.pg_claim_id, p_tid, p_amount);
    perform set_config('app.nicepay_review_ok', '', true);
    return v_res;
end;
$$;

-- 실제 NICEPAY 승인 취소(또는 망취소) 확인 기록(전액). 서버가 검증한 승인 기록(p_pg_tid)에 대해서만 남길 수 있다.
--   api_response  : 서버가 취소/망취소 응답을 검증(p_response_digest 필수)
--   admin_console : 운영자가 관리자 화면에서 확인(처리자와 다른 승인자 p_approver 필수 — 2인 승인)
-- 대상 주문은 (a) 승인 완료(done)되고 pg_tid가 이 거래이거나, (b) 검토 대기/선점 중(approving)이고 승인 기록의 선점이 현재 선점인 주문.
create or replace function nicepay_record_pg_cancel(p_order_id uuid, p_pg_tid text, p_cancel_tid text, p_cancel_amount integer, p_source text, p_actor text, p_approver text default null, p_response_digest text default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v orders;
    a nicepay_pg_approvals;
    r nicepay_pg_cancels;
begin
    if p_source is null or p_source not in ('api_response', 'admin_console') then raise exception '취소 확인 출처가 올바르지 않아요'; end if;
    if p_cancel_tid is null or length(btrim(p_cancel_tid)) < 4 then raise exception '취소 거래번호를 입력해주세요'; end if;
    if p_actor is null or length(btrim(p_actor)) < 2 then raise exception '처리자를 입력해주세요'; end if;
    if p_source = 'admin_console' and (p_approver is null or length(btrim(p_approver)) < 2 or btrim(p_approver) = btrim(p_actor)) then
        raise exception '처리자와 다른 승인자가 필요해요(2인 승인)';
    end if;
    if p_source = 'api_response' and (p_response_digest is null or p_response_digest !~ '^[0-9a-f]{64}$') then
        raise exception '취소 응답 요약값이 필요해요';
    end if;
    select * into v from orders where id = p_order_id for update;
    if not found then raise exception '주문을 찾을 수 없어요'; end if;
    if v.payment_provider is distinct from 'nicepay' then raise exception 'NICEPAY 주문이 아니에요'; end if;
    select * into a from nicepay_pg_approvals where tid = p_pg_tid and order_id = p_order_id;
    if not found then raise exception '서버가 검증한 PG 승인 기록이 없는 거래예요'; end if;
    if not ((v.status = 'done' and v.pg_tid = a.tid) or (v.status = 'approving' and v.pg_claim_id = a.claim_id)) then
        raise exception '취소 확인을 기록할 수 없는 주문 상태예요';
    end if;
    if p_cancel_amount is distinct from a.amount then raise exception '전액 취소만 기록할 수 있어요'; end if;
    if btrim(p_cancel_tid) = a.tid then raise exception '취소 거래번호가 승인 거래번호와 같아요'; end if;
    select * into r from nicepay_pg_cancels where order_id = p_order_id and pg_tid = a.tid;
    if found then
        if r.cancel_tid = btrim(p_cancel_tid) then return json_build_object('already_recorded', true); end if;
        raise exception '이미 다른 취소 거래가 기록된 주문이에요';
    end if;
    insert into nicepay_pg_cancels(order_id, pg_tid, cancel_tid, cancel_amount, source, actor, approver, response_digest)
    values (p_order_id, a.tid, btrim(p_cancel_tid), p_cancel_amount, p_source, btrim(p_actor), nullif(btrim(coalesce(p_approver, '')), ''), p_response_digest);
    return json_build_object('already_recorded', false);
end;
$$;

revoke all on function nicepay_order_context(uuid) from public, anon, authenticated;
revoke all on function nicepay_claim_order(uuid) from public, anon, authenticated;
revoke all on function nicepay_record_verified_approval(uuid, uuid, text, integer, text) from public, anon, authenticated;
revoke all on function nicepay_release_order(uuid, uuid, text) from public, anon, authenticated;
revoke all on function nicepay_mark_review(uuid, uuid, text) from public, anon, authenticated;
revoke all on function nicepay_expire_stale_claims(interval) from public, anon, authenticated;
revoke all on function nicepay_resolve_review(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function confirm_nicepay_payment(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function nicepay_confirm_reviewed(uuid, text, integer, text, text, text, text) from public, anon, authenticated;
revoke all on function nicepay_record_pg_cancel(uuid, text, text, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function nicepay_order_context(uuid) to service_role;
grant execute on function nicepay_claim_order(uuid) to service_role;
grant execute on function nicepay_record_verified_approval(uuid, uuid, text, integer, text) to service_role;
grant execute on function nicepay_release_order(uuid, uuid, text) to service_role;
grant execute on function nicepay_mark_review(uuid, uuid, text) to service_role;
grant execute on function nicepay_expire_stale_claims(interval) to service_role;
grant execute on function nicepay_resolve_review(uuid, text, text, text, text, text, text) to service_role;
grant execute on function confirm_nicepay_payment(uuid, uuid, text, integer) to service_role;
grant execute on function nicepay_confirm_reviewed(uuid, text, integer, text, text, text, text) to service_role;
grant execute on function nicepay_record_pg_cancel(uuid, text, text, integer, text, text, text, text) to service_role;
grant select, insert on table nicepay_review_actions to service_role;
grant select, insert on table nicepay_pg_approvals to service_role;
grant select, insert on table nicepay_pg_cancels to service_role;

commit;
