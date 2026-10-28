-- fix_nicepay_gate_reviewer_flag_20261029.sql 되돌리기: 두 게이트 함수를 적용 전 운영 정의로 복원하고 helper 를 삭제한다.
-- ⚠ 안전장치: 게이트 mode 가 'off' 가 아니면 오류로 중단한다(reviewer/public 모드에서 판별 로직을 되돌리면 진행 중인 심사 결제의 승인 선점 판정이 도중에 바뀐다).
--   먼저 mode 를 off 로 닫고(close_nicepay_review_20261029.sql 또는 update nicepay_checkout_gate set mode='off'), 진행 중(approving) 거래가 없는지 확인한 뒤 실행한다.
-- ⚠ 진행 중 거래 안전장치: payment_provider='nicepay' 이고 status='approving'(승인 선점 후 미해소) 주문이 하나라도 있으면 아무것도 바꾸지 않고 중단한다.
-- ⚠ 되돌리면 토스 심사 계정(pg_checkout_override)이 mode='reviewer' 에서 NICEPAY 주문을 만들 수 있게 되고, 심사 센터 소속 검증이 사라진다(mode 가 off 인 동안은 영향 없음).
-- 복원 결과 정의 해시가 적용 전 운영 정의와 다르면(또는 현재 정의가 이 파일 적용본이 아니면) 아무것도 바꾸지 않고 중단한다.
begin;
do $$
declare
    r record; v_def text; v_new text; v_h text; v_mode text; v_inflight int;
begin
    select mode into v_mode from nicepay_checkout_gate where id;
    if v_mode is distinct from 'off' then
        raise exception '롤백 중단: NICEPAY 게이트 mode 가 off 가 아니에요(현재 %). 먼저 mode 를 off 로 닫고 진행 중 거래가 없는지 확인하세요.', coalesce(v_mode, 'NULL');
    end if;
    -- 진행 중(승인 선점 후 결과 미확정) NICEPAY 거래가 하나라도 있으면 중단: approving 주문은 아직 승인/취소/release 중 하나로 해소되지 않았다.
    select count(*) into v_inflight from orders where payment_provider = 'nicepay' and status = 'approving';
    if v_inflight > 0 then
        raise exception '롤백 중단: 승인 선점 상태(approving)의 NICEPAY 주문이 %건 있어요. 승인 확정·취소·release 로 모두 해소된 뒤 다시 실행하세요.', v_inflight;
    end if;
    for r in
        select * from (values
            ('public.orders_guard_nicepay_create()', 'b2f340d8d41fc2428e26c7cde3aaafd4', '721bef6e27646547535cfe7b05393f88'),
            ('public.nicepay_claim_order(uuid)',     '4cb7d4ece28db732bd5886088c034609', 'd7145831da2f416612818d2e4fe5d5fc')
        ) as t(sig, pre_md5, post_md5)
    loop
        if to_regprocedure(r.sig) is null then continue; end if;
        v_def := pg_get_functiondef(to_regprocedure(r.sig)); v_h := md5(v_def);
        if v_h = r.pre_md5 then raise notice '%: 이미 적용 전 정의 — 건너뜀', r.sig; continue; end if;
        if v_h <> r.post_md5 then raise exception '% 의 현재 정의가 이 파일 적용본이 아니에요(해시 %) — 덮어쓰지 않고 중단합니다', r.sig, v_h; end if;
        if r.sig like 'public.orders_guard%' then
            v_new := replace(v_def, 'a.nicepay_review_access and nicepay_order_is_review_target(new.center_id, new.product_id)', 'a.pg_checkout_override');
        else
            v_new := replace(v_def, 'ga.nicepay_review_access and nicepay_order_is_review_target(go.center_id, go.product_id)', 'ga.pg_checkout_override');
            v_new := replace(v_new, 'accounts.nicepay_review_access + 심사 센터 주문', 'accounts.pg_checkout_override');
        end if;
        execute v_new;
        if md5(pg_get_functiondef(to_regprocedure(r.sig))) <> r.pre_md5 then
            raise exception '% 복원 결과 정의 해시가 적용 전 운영 정의와 달라요 — 트랜잭션 전체를 롤백합니다', r.sig;
        end if;
    end loop;
end $$;
drop function if exists public.nicepay_order_is_review_target(uuid, uuid);
commit;
