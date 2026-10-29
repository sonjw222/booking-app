-- ============================================================
-- 만료 상품 기존 pending 직접결제 주문 처리(2026-10-31) — 운영 미적용 제안.  선행: fix_expired_fixed_date_products_20261031.sql(PR #251) 적용.
-- 배경: 고정 만료일이 지난 상품의 기존 pending 주문을 그대로 "확정·발급"하면 처음부터 만료된 수강권이 발급된다. 센터 관리자가 실제 수납 여부를 확인해 처리한다.
--   ① 미수납 확인 → 주문 cancelled(수강권·매출 없음, 기존 트리거가 포인트 복원)
--   ② 수납 확인 + 환불 → '환불 예정'(주문은 pending 유지·발급 불가) → 센터가 외부에서 환불 → '환불 완료 확인' 시에만 주문 cancelled
--   ③ 수납 확인 + 이용기간 조정 → 수납 확인·발급·기간 조정·매출 반영을 한 서버 작업(트랜잭션)으로. 상품의 expiry_date 는 바꾸지 않고, 이 주문의 수강권 1건에만 새 만료일 적용
--   ④ 수납 여부 불명 → 아무것도 하지 않음(pending 유지)
-- 변경:
--   · 새 테이블 order_expiry_resolutions(처리 이력: 사유·처리자·처리일·수납 정보). RLS 켬, 클라이언트는 조회만(쓰기는 아래 RPC 로만)
--   · 새 RPC manager_resolve_expired_order(...) — 권한은 fulfill_order 와 같은 규칙(has_permission(center,'pass.payment.create') 또는 플랫폼 운영자). 일반 회원·타 센터 관리자 거부
--   · fulfill_order(uuid) 를 "제자리 패치"(운영 현재 정의에 2곳만 삽입): 만료 상품 주문은 위 RPC 안에서만 발급 가능(직접 호출 우회 차단), 환불/취소 기록 주문 발급 차단, RPC 가 지정한 만료일 적용
-- 안전장치: fulfill_order 현재 정의 해시가 ⓐ 적용 전 운영 정의 또는 ⓑ 이 파일 적용본이 아니면 덮어쓰지 않고 중단, 치환 위치 1곳씩 아니면 중단, 결과 해시가 기대값과 다르면 전체 롤백.
-- 건드리지 않는 것: PG 승인 경로(_issue_membership_and_record_payment), NICEPAY 게이트·P2/P2b, 주문 트리거, 상품 데이터, 기존 주문·수강권·결제.
-- 롤백: rollback_add_expired_order_resolution_20261031.sql
-- ============================================================
begin;
do $$
declare v_h text; v_n int;
begin
    if to_regprocedure('public.fixed_expiry_passed(text,date)') is null or to_regprocedure('public.product_fixed_expiry_passed(uuid)') is null then
        raise exception 'fix_expired_fixed_date_products_20261031.sql(PR #251)을 먼저 적용하세요';
    end if;
    if to_regprocedure('public.has_permission(uuid,text)') is null or to_regprocedure('public.my_account_id()') is null or to_regprocedure('public.is_platform_admin()') is null then
        raise exception 'has_permission/my_account_id/is_platform_admin 이 없어요 — 중단';
    end if;
    if to_regprocedure('public.fulfill_order(uuid)') is null then raise exception 'fulfill_order(uuid) 가 없어요 — 중단'; end if;
    v_h := md5(pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure));
    if v_h not in ('b675acdd9c48bba4b4a80891cbba0a76', '18c4bb13b1b1f812b6dbef882f0ce068') then
        raise exception 'fulfill_order 현재 정의가 예상(적용 전 운영 정의/이 파일 적용본)과 달라요(해시 %) — 덮어쓰지 않고 중단합니다', v_h;
    end if;
end $$;

-- ── 처리 이력 테이블 ──
create table if not exists public.order_expiry_resolutions (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null unique references public.orders(id) on delete cascade,
    center_id uuid not null references public.centers(id) on delete cascade,
    resolution text not null check (resolution in ('unpaid_cancelled', 'refund_planned', 'refund_completed', 'period_adjusted')),
    reason text not null check (length(btrim(reason)) >= 2),
    received_amount integer check (received_amount is null or received_amount >= 0),
    received_at date,
    received_method text check (received_method is null or received_method in ('cash', 'transfer', 'card', 'other')),
    new_expires_on date,
    membership_id uuid references public.memberships(id) on delete set null,
    product_expiry_date_snapshot date,
    handled_by uuid references public.accounts(id) on delete set null,
    handled_at timestamptz not null default now(),
    refund_completed_at timestamptz,
    refund_completed_by uuid references public.accounts(id) on delete set null,
    refund_note text,
    updated_at timestamptz not null default now()
);
create index if not exists order_expiry_resolutions_center_idx on public.order_expiry_resolutions(center_id, handled_at desc);
alter table public.order_expiry_resolutions enable row level security;
drop policy if exists "만료 주문 처리 매니저 조회" on public.order_expiry_resolutions;
create policy "만료 주문 처리 매니저 조회" on public.order_expiry_resolutions for select to authenticated
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());
revoke all on public.order_expiry_resolutions from public, anon, authenticated;
grant select on public.order_expiry_resolutions to authenticated;
grant all on public.order_expiry_resolutions to service_role;

-- ── 처리 RPC ──
create or replace function public.manager_resolve_expired_order(
    p_order_id uuid, p_action text, p_reason text,
    p_received_amount integer default null, p_received_at date default null, p_received_method text default null,
    p_new_expires_on date default null, p_refunded_at date default null)
returns json language plpgsql security definer set search_path = public as $fn$
declare
    v_order orders; v_prod record; v_res order_expiry_resolutions;
    v_today date := (now() at time zone 'Asia/Seoul')::date;
    v_account uuid; v_reason text := btrim(coalesce(p_reason, '')); v_fulfill json; v_mid uuid;
begin
    if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
    if p_action is null or p_action not in ('unpaid_cancel', 'refund_plan', 'refund_complete', 'adjust_period') then
        raise exception '알 수 없는 처리 방식이에요';
    end if;
    select * into v_order from orders where id = p_order_id for update;     -- 같은 주문의 동시 처리를 직렬화
    if not found then raise exception '주문을 찾을 수 없어요'; end if;
    if not (has_permission(v_order.center_id, 'pass.payment.create') or is_platform_admin()) then
        raise exception '이 주문을 처리할 권한이 없어요';
    end if;
    if length(v_reason) < 2 then raise exception '처리 사유를 입력해주세요'; end if;
    if v_order.payment_provider is not null or coalesce(v_order.pay_method, 'direct') <> 'direct' then
        raise exception '직접결제 주문만 이 기능으로 처리할 수 있어요(PG 결제 주문은 PG 처리 경로를 따라요)';
    end if;
    v_account := my_account_id();
    select * into v_res from order_expiry_resolutions where order_id = p_order_id for update;

    if p_action = 'refund_complete' then
        if v_res.id is null or v_res.resolution <> 'refund_planned' then raise exception '환불 예정으로 기록된 주문만 환불 완료 처리할 수 있어요'; end if;
        if v_order.status <> 'pending' then raise exception '이미 처리된 주문이에요(현재 %)', v_order.status; end if;
        if coalesce(p_refunded_at, v_today) > v_today then raise exception '환불일은 오늘 이후일 수 없어요'; end if;
        if coalesce(p_refunded_at, v_today) < v_res.received_at then raise exception '환불일은 수납일보다 빠를 수 없어요'; end if;
        update orders set status = 'cancelled' where id = p_order_id;     -- 기존 트리거가 사용한 포인트를 복원한다
        update order_expiry_resolutions
           set resolution = 'refund_completed', refund_completed_at = coalesce(p_refunded_at, v_today)::timestamp at time zone 'Asia/Seoul',
               refund_completed_by = v_account, refund_note = v_reason, updated_at = now()
         where id = v_res.id;
        return json_build_object('action', p_action, 'order_status', 'cancelled', 'resolution', 'refund_completed');
    end if;

    if v_order.status <> 'pending' then raise exception '확인 대기 상태의 주문만 처리할 수 있어요(현재 %)', v_order.status; end if;
    if v_res.id is not null then raise exception '이미 처리가 기록된 주문이에요(%)', v_res.resolution; end if;
    select p.expiry_mode, p.expiry_date into v_prod from products p where p.id = v_order.product_id;
    if not found or not fixed_expiry_passed(v_prod.expiry_mode, v_prod.expiry_date) then
        raise exception '판매 기간이 지난 상품의 주문만 이 기능으로 처리할 수 있어요(일반 주문은 확정·발급 또는 취소를 이용하세요)';
    end if;

    if p_action = 'unpaid_cancel' then
        update orders set status = 'cancelled' where id = p_order_id;     -- 수강권·매출 없음. 기존 트리거가 사용한 포인트를 복원한다
        insert into order_expiry_resolutions(order_id, center_id, resolution, reason, product_expiry_date_snapshot, handled_by)
        values (p_order_id, v_order.center_id, 'unpaid_cancelled', v_reason, v_prod.expiry_date, v_account);
        return json_build_object('action', p_action, 'order_status', 'cancelled', 'resolution', 'unpaid_cancelled');
    end if;

    -- 수납 확인이 필요한 두 방식(환불 예정 / 이용기간 조정): 실제 수납 금액·수납일·수단을 모두 받는다
    if p_received_amount is null or p_received_at is null or p_received_method is null then raise exception '수납 금액·수납일·수납 수단을 모두 입력해주세요'; end if;
    if p_received_method not in ('cash', 'transfer', 'card', 'other') then raise exception '수납 수단이 올바르지 않아요'; end if;
    if p_received_amount <> v_order.amount then raise exception '수납 금액(%원)이 주문 금액(%원)과 달라요 — 전액 수납이 확인되지 않으면 처리하지 말고 대기 상태로 두세요', p_received_amount, v_order.amount; end if;
    if p_received_at > v_today then raise exception '수납일은 오늘 이후일 수 없어요'; end if;
    if p_received_at < (v_order.created_at at time zone 'Asia/Seoul')::date then raise exception '수납일은 주문일보다 빠를 수 없어요'; end if;

    if p_action = 'refund_plan' then
        insert into order_expiry_resolutions(order_id, center_id, resolution, reason, received_amount, received_at, received_method, product_expiry_date_snapshot, handled_by)
        values (p_order_id, v_order.center_id, 'refund_planned', v_reason, p_received_amount, p_received_at, p_received_method, v_prod.expiry_date, v_account);
        return json_build_object('action', p_action, 'order_status', 'pending', 'resolution', 'refund_planned');   -- 주문은 pending 유지(발급·매출 없음), 환불 완료 확인 때 정리
    end if;

    -- adjust_period: 수납 확인 + 발급 + 기간 조정 + 매출 반영을 한 트랜잭션으로(어느 단계든 실패하면 전부 롤백)
    if p_new_expires_on is null or p_new_expires_on <= v_today then raise exception '새 만료일은 오늘(KST)보다 뒤여야 해요'; end if;
    perform set_config('app.expired_order_resolution', p_order_id::text, true);
    perform set_config('app.expired_order_new_expiry', p_new_expires_on::text, true);
    v_fulfill := fulfill_order(p_order_id);
    perform set_config('app.expired_order_resolution', '', true);
    perform set_config('app.expired_order_new_expiry', '', true);
    v_mid := nullif(v_fulfill->>'membership_id', '')::uuid;
    if v_mid is null then raise exception '수강권 발급에 실패했어요 — 전부 취소합니다'; end if;
    update payments set memo = '앱 주문 자동 발급 · 만료 상품 이용기간 조정(수납 확인: ' || p_received_method || ' ' || p_received_at::text || ')' where order_id = p_order_id;
    insert into order_expiry_resolutions(order_id, center_id, resolution, reason, received_amount, received_at, received_method, new_expires_on, membership_id, product_expiry_date_snapshot, handled_by)
    values (p_order_id, v_order.center_id, 'period_adjusted', v_reason, p_received_amount, p_received_at, p_received_method, p_new_expires_on, v_mid, v_prod.expiry_date, v_account);
    return json_build_object('action', p_action, 'order_status', 'done', 'resolution', 'period_adjusted', 'membership_id', v_mid, 'new_expires_on', p_new_expires_on);
end;
$fn$;
comment on function public.manager_resolve_expired_order(uuid, text, text, integer, date, text, date, date) is '2026-10-31 만료 상품 기존 pending 직접결제 주문 처리(미수납 취소/환불 예정·완료/이용기간 조정 발급). 권한=fulfill_order 와 동일.';
revoke all on function public.manager_resolve_expired_order(uuid, text, text, integer, date, text, date, date) from public, anon;
grant execute on function public.manager_resolve_expired_order(uuid, text, text, integer, date, text, date, date) to authenticated, service_role;

-- ── fulfill_order 제자리 패치 ──
do $$
declare v_def text; v_new text; v_h text; v_n int;
begin
    v_def := pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure); v_h := md5(v_def);
    if v_h = '18c4bb13b1b1f812b6dbef882f0ce068' then raise notice 'fulfill_order: 이미 이 파일의 정의로 바뀜 — 건너뜀'; return; end if;
    if v_h <> 'b675acdd9c48bba4b4a80891cbba0a76' then raise exception 'fulfill_order 현재 정의가 예상과 달라요(해시 %) — 중단', v_h; end if;
    v_n := (length(v_def) - length(replace(v_def, '-- fulfill_nicepay_guard end', ''))) / length('-- fulfill_nicepay_guard end');
    if v_n <> 1 then raise exception 'fulfill_order: 삽입 위치 ①이 1곳이 아니에요(%곳) — 중단', v_n; end if;
    v_n := (length(v_def) - length(replace(v_def, 'insert into memberships (', ''))) / length('insert into memberships (');
    if v_n <> 1 then raise exception 'fulfill_order: 삽입 위치 ②가 1곳이 아니에요(%곳) — 중단', v_n; end if;
    v_new := replace(v_def, '-- fulfill_nicepay_guard end', '-- fulfill_nicepay_guard end' || chr(10) ||
'    -- expired_order_guard begin (2026-10-31)' || chr(10) ||
'    if v_order.product_id is not null' || chr(10) ||
'       and coalesce((select fixed_expiry_passed(p.expiry_mode, p.expiry_date) from products p where p.id = v_order.product_id), false)' || chr(10) ||
'       and coalesce(current_setting(''app.expired_order_resolution'', true), '''') <> p_order_id::text then' || chr(10) ||
'        raise exception ''판매 기간이 지난 상품의 주문이에요. 주문 관리의 "만료 상품 주문 처리"에서 수납 여부를 확인해 처리해주세요.'';' || chr(10) ||
'    end if;' || chr(10) ||
'    if exists (select 1 from order_expiry_resolutions r where r.order_id = p_order_id) then' || chr(10) ||
'        raise exception ''만료 상품 주문 처리(미수납 취소/환불)가 기록된 주문은 발급할 수 없어요'';' || chr(10) ||
'    end if;' || chr(10) ||
'    -- expired_order_guard end');
    v_new := replace(v_new, 'insert into memberships (',
'if coalesce(current_setting(''app.expired_order_resolution'', true), '''') = p_order_id::text then' || chr(10) ||
'        v_expires := nullif(current_setting(''app.expired_order_new_expiry'', true), '''')::date;   -- 만료 상품 주문 처리(이용기간 조정): 이 주문의 수강권에만 적용' || chr(10) ||
'    end if;' || chr(10) ||
'    insert into memberships (');
    execute v_new;
    if md5(pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure)) <> '18c4bb13b1b1f812b6dbef882f0ce068' then
        raise exception 'fulfill_order 패치 결과 해시가 기대값과 달라요 — 트랜잭션 전체를 롤백합니다';
    end if;
end $$;
commit;
