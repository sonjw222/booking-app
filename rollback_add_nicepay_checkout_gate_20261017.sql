-- 롤백: NICEPAY 주문 생성 DB 게이트 제거. 보호 장치 — (1) NICEPAY provider 지원(add_nicepay_provider_support)이 적용돼 있으면 먼저 그 롤백을 해야 한다(게이트 없이 NICEPAY 허용 상태가 되는 것 방지),
-- (2) 게이트가 켜져 있거나(mode ≠ off) 감사 기록이 시드 이상이면 감사 기록 보존을 위해 테이블은 지우지 않고 중단한다.
begin;
do $$
begin
    if exists (select 1 from pg_constraint where conname = 'orders_payment_provider_check' and pg_get_constraintdef(oid) like '%nicepay%') then
        raise exception 'orders가 nicepay provider를 허용 중이에요 — rollback_add_nicepay_provider_support 를 먼저 실행하세요(게이트 없이 NICEPAY 주문이 열리는 것을 막기 위해 중단)';
    end if;
    if exists (select 1 from nicepay_checkout_gate where mode <> 'off') or (select count(*) from nicepay_checkout_gate_audit) > 1 then
        raise exception '게이트가 켜져 있거나(mode ≠ off) 감사 기록(변경 이력)이 있어요 — 기록 보존을 위해 중단합니다(운영자 확인 후 수동 정리)';
    end if;
end $$;
drop trigger if exists orders_guard_nicepay_create on orders;
drop function if exists orders_guard_nicepay_create();
drop trigger if exists nicepay_checkout_gate_audit on nicepay_checkout_gate;
drop trigger if exists nicepay_checkout_gate_no_delete on nicepay_checkout_gate;
drop trigger if exists nicepay_checkout_gate_audit_append_only on nicepay_checkout_gate_audit;
drop function if exists nicepay_checkout_mode();
drop function if exists nicepay_checkout_gate_audit_fn();
drop function if exists nicepay_checkout_gate_immutable_fn();
drop table if exists nicepay_checkout_gate_audit;
drop table if exists nicepay_checkout_gate;
commit;
