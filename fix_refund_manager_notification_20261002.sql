-- ============================================================
-- 관리자 알림: 회원 셀프 환불 완료(refund_completed) + push_notification 실행 권한 회수 — 2026-10-02
--
-- 기존 환불/주문 함수(_refund_membership_core, fulfill_order 등)는 재정의하지 않는다. 신규 객체만 추가한다.
-- 재사용: push_notification(recipient, kind, title, body, center, link, data) — Production에서 시그니처 확인(SECURITY DEFINER, search_path=public).
--
-- [1] refund_completed — memberships.status가 'refunded'로 "바뀌는" UPDATE에 연결된 DEFERRABLE INITIALLY DEFERRED constraint trigger.
--     · 현재 memberships.status='refunded'를 만드는 서버 경로는 _refund_membership_core 하나다(refund_membership 브라우저 래퍼/refund_membership_server도 core 호출).
--       core는 수강권 UPDATE → 환불 payments INSERT → 쿠폰/포인트 복원 순이라, 커밋 직전에 실행되는 deferred 트리거가 최종 환불 금액(음수 payments 합)을 정확히 본다.
--     · 같은 트랜잭션이라 환불이 롤백되면 알림도 롤백된다(환불 실패/불가/PG 취소 실패는 core가 호출되지 않거나 롤백되므로 알림 없음).
--     · 중복 방지: refund_notification_events(membership_id PK) — 상태가 다시 바뀌어도, 관리자가 알림을 삭제해도 재생성되지 않는다.
--     · 알림 실패가 환불을 막지 않는다(서브트랜잭션으로 격리, WARNING만 남김). 실 PG에서는 토스 취소가 이미 성공한 뒤의 DB 환불이므로 알림 때문에 환불 트랜잭션이 실패하면 더 위험하다.
--       이 경우 마커도 함께 롤백되어 그 환불에 대해서는 알림이 누락될 뿐이다(누락 리스크는 보고서 참조).
-- [2] push_notification: 클라이언트 직접 호출처가 없음을 확인한 뒤 public/anon/authenticated EXECUTE 회수(DB 내부 SECURITY DEFINER 호출은 영향 없음).
-- OS 푸시: 별도 코드 없음 — supabase/functions/send-web-push가 notifications의 pushed_at IS NULL 행을 kind 필터 없이 처리하므로 refund_completed도
--   Production push pipeline(활성화돼 있다면)의 기존 큐를 통해 web push / native FCM 대상이 된다.
-- 여러 번 실행해도 안전(if not exists / create or replace / drop trigger if exists). 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================
begin;

-- [1] 환불 완료 알림 ------------------------------------------------
create table if not exists public.refund_notification_events (
    membership_id uuid primary key references public.memberships(id) on delete cascade,
    created_at timestamptz not null default now()
);
alter table public.refund_notification_events enable row level security;
revoke all on public.refund_notification_events from public, anon, authenticated;

create or replace function public.notify_refund_completed_managers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_mem       public.memberships;
    v_recipient uuid;
    v_amount    bigint;
    v_body      text;
begin
    select * into v_mem from public.memberships where id = new.id;
    if not found or v_mem.status <> 'refunded' then
        return null;
    end if;

    begin   -- 알림 실패는 환불을 막지 않는다(마커도 함께 롤백)
        insert into public.refund_notification_events(membership_id) values (new.id)
        on conflict (membership_id) do nothing;
        if not found then
            return null;   -- 이미 알린 환불(재시도/중복/동시 요청 포함 — PK가 직렬화)
        end if;

        select coalesce(sum(-total_amount), 0) into v_amount
          from public.payments
         where membership_id = new.id and sale_type = 'refund' and total_amount < 0;

        v_body := left(coalesce(v_mem.product_name, '수강권'), 80) || ' · ' ||
                  case when v_amount > 0 then to_char(v_amount, 'FM999,999,999,999,999,999,990') || '원 환불 완료'
                       else '환불 처리 완료(환불 금액 없음)' end;

        for v_recipient in
            select distinct account_id from public.manager_centers
             where center_id = v_mem.center_id and status = 'active'
        loop
            perform public.push_notification(
                v_recipient, 'refund_completed', '수강권 환불이 완료됐어요', v_body,
                v_mem.center_id, '/manager/sales?center=' || v_mem.center_id::text,
                jsonb_build_object('membership_id', v_mem.id, 'center_id', v_mem.center_id, 'refund_amount', v_amount)
            );
        end loop;
    exception when others then
        raise warning 'refund_completed notification skipped for membership %: %', new.id, sqlerrm;
    end;
    return null;
end;
$$;
revoke all on function public.notify_refund_completed_managers() from public, anon, authenticated;

drop trigger if exists trg_refund_completed_managers on public.memberships;
create constraint trigger trg_refund_completed_managers
after update on public.memberships
deferrable initially deferred
for each row
when (old.status is distinct from new.status and new.status = 'refunded')
execute function public.notify_refund_completed_managers();

-- [2] push_notification 실행 권한 회수 -------------------------------------
-- 저장소 전체 감사: 클라이언트(app/lib/supabase edge functions)에서 rpc("push_notification")을 호출하는 곳이 없고, Production에서 이 함수를 쓰는 함수 9개
-- (create_announcement, create_marketing_message_safe, notify_expiring_passes, notify_upcoming_reservations, run_autocancel_sweep,
--  trg_notify_new_order/new_review/reservation_insert/reservation_update)는 모두 SECURITY DEFINER(소유자 권한으로 실행)라 영향이 없다.
-- 로그인한 일반 사용자가 임의 수신자에게 알림을 만들 수 있던 경로를 닫는다(service_role/소유자 권한은 유지).
revoke all on function public.push_notification(uuid, text, text, text, uuid, text, jsonb) from public, anon, authenticated;

commit;

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select
    (select count(*) from pg_trigger where tgname = 'trg_refund_completed_managers' and not tgisinternal) as refund_trigger_must_be_1,
    (select tgdeferrable and tginitdeferred from pg_trigger where tgname = 'trg_refund_completed_managers') as refund_trigger_deferred_must_be_true,
    (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'refund_notification_events') as marker_table_must_be_1,
    has_table_privilege('authenticated', 'public.refund_notification_events', 'select') as marker_auth_select_must_be_false,
    has_function_privilege('anon', 'public.push_notification(uuid,text,text,text,uuid,text,jsonb)', 'execute') as push_anon_must_be_false,
    has_function_privilege('authenticated', 'public.push_notification(uuid,text,text,text,uuid,text,jsonb)', 'execute') as push_auth_must_be_false,
    has_function_privilege('authenticated', 'public.notify_refund_completed_managers()', 'execute') as trigger_fn_auth_must_be_false;
