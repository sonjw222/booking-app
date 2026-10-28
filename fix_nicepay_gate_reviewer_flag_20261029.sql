-- ============================================================
-- NICEPAY 결제 게이트의 "심사관" 판별을 전용 권한(accounts.nicepay_review_access) + 심사 센터 소속 검증으로 강화(2026-10-29, 외부 SQL 리뷰 반영 개정) — 검토용 초안, 운영 미실행.
--
-- 배경: 운영에 이미 적용된 두 함수가 mode='reviewer' 일 때 심사관을 accounts.pg_checkout_override(토스용)로만 판별한다.
--   · orders_guard_nicepay_create()  — 20261017134256_add_nicepay_checkout_gate_20261017 (NICEPAY 대기 주문 생성 트리거)
--   · nicepay_claim_order(uuid)      — 20261017151331_add_nicepay_provider_support_20261016_v8 (승인 선점)
-- 변경(두 함수 모두, 문자열 치환 2곳씩 — 다른 로직은 바꾸지 않는다):
--   ① 판별 권한: pg_checkout_override → nicepay_review_access (토스 심사 계정이 NICEPAY 주문을 만들 수 없게)
--   ② 대상 검증: reviewer 모드에서는 "주문의 실제 센터와 상품이 심사 대상인지"도 확인한다(nicepay_order_is_review_target: 승인·비내부 심사 센터 + 그 센터의 판매 중 상품, 상품 NULL 은 제외).
--      권한만 보면 심사관 계정이 운영 센터 주문으로도 NICEPAY 결제 게이트를 통과할 수 있다(센터 분리 SQL 의 트리거가 없거나 서버(service_role) 경로로 만든 주문이면 막는 곳이 없다).
--   public/off 모드, 과거 결제 처리(이미 approving 인 주문의 승인 기록·확정·취소·release·환불), service_role 의 주문 생성 경로는 바뀌지 않는다.
-- 안전장치(덮어쓰기 방지): 대상 두 함수의 "현재 정의 해시"가 ⓐ 적용 전 운영 정의(2026-10-29 읽기 전용 조회 값) 또는 ⓑ 이 파일을 적용한 결과 정의와 정확히 같을 때만 진행한다.
--   ⓐ 도 ⓑ 도 아니면(운영에서 따로 바뀐 정의) 아무것도 바꾸지 않고 중단한다. 치환 후 정의 해시가 기대값과 다르면 트랜잭션 전체를 롤백한다.
-- 전제: add_nicepay_review_center_isolation_20261028.sql(P2)이 먼저 적용돼 accounts.nicepay_review_access·centers.is_nicepay_review 가 있어야 한다(없으면 중단).
-- 영향: mode 가 'off'(현재)이면 동작 차이 없음. 'reviewer' 모드에서 NICEPAY 주문 생성·승인 선점이 "전용 권한 계정 + 심사 센터 주문"에만 허용된다. 'public' 모드는 영향 없음.
-- 롤백: rollback_fix_nicepay_gate_reviewer_flag_20261029.sql(게이트 mode 가 off 일 때만 실행). 검증: verify_fix_nicepay_gate_reviewer_flag_20261029.sql(읽기 전용).
-- ============================================================
begin;
do $$
declare
    r record; v_def text; v_new text; v_h text; v_n int;
begin
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounts' and column_name='nicepay_review_access') then
        raise exception 'accounts.nicepay_review_access 가 없어요 — add_nicepay_review_center_isolation_20261028.sql 을 먼저 적용하세요';
    end if;
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review') then
        raise exception 'centers.is_nicepay_review 가 없어요 — add_nicepay_review_center_isolation_20261028.sql 을 먼저 적용하세요';
    end if;
    if to_regprocedure('public.nicepay_checkout_mode()') is null then
        raise exception 'nicepay_checkout_mode() 가 없어요 — NICEPAY 게이트 SQL 이 적용돼 있어야 해요';
    end if;
    -- 대상 판정 helper — reviewer 모드 전용. 모두 만족해야 "심사 대상 주문"이다:
    --   · 센터가 심사 센터이고 승인(approved)·비내부 상태(심사관에게 실제로 열려 있는 센터. 닫힌/비승인 센터의 대기 주문은 선점 불가)
    --   · 상품이 있고(NULL 상품 주문은 서버가 계산한 금액이 없어 심사 결제 대상이 아니다 — 앱은 항상 product_id 를 보낸다), 그 센터의 상품이며, 판매 중(is_active·is_on_sale: create_order_secure 와 member_can_purchase_product 의 구매 조건과 동일)
    -- 이 함수는 두 게이트 함수(소유자 권한)만 호출한다. public/off 모드와 이미 approving 인 주문의 후속 처리는 이 함수를 쓰지 않는다.
    create or replace function public.nicepay_order_is_review_target(p_center_id uuid, p_product_id uuid)
    returns boolean language sql stable security definer set search_path = public as $f$
        select p_center_id is not null and p_product_id is not null
           and exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review and c.status = 'approved' and not c.is_internal)
           and exists (select 1 from products pr where pr.id = p_product_id and pr.center_id = p_center_id and pr.is_active and pr.is_on_sale);
    $f$;
    revoke all on function public.nicepay_order_is_review_target(uuid, uuid) from public, anon, authenticated;

    for r in
        select * from (values
            ('public.orders_guard_nicepay_create()', 'b2f340d8d41fc2428e26c7cde3aaafd4', '721bef6e27646547535cfe7b05393f88'),
            ('public.nicepay_claim_order(uuid)',     '4cb7d4ece28db732bd5886088c034609', 'd7145831da2f416612818d2e4fe5d5fc')
        ) as t(sig, pre_md5, post_md5)
    loop
        if to_regprocedure(r.sig) is null then raise exception '% 가 없어요 — NICEPAY 게이트/지원 SQL 이 적용돼 있어야 해요', r.sig; end if;
        v_def := pg_get_functiondef(to_regprocedure(r.sig)); v_h := md5(v_def);
        if v_h = r.post_md5 then raise notice '%: 이미 이 파일의 정의로 바뀜 — 건너뜀', r.sig; continue; end if;
        if v_h <> r.pre_md5 then
            raise exception '% 의 현재 정의가 예상(적용 전 운영 정의/이 파일 적용본)과 달라요(해시 %) — 덮어쓰지 않고 중단합니다', r.sig, v_h;
        end if;
        if r.sig like 'public.orders_guard%' then
            v_n := (length(v_def) - length(replace(v_def, 'a.pg_checkout_override', ''))) / length('a.pg_checkout_override');
            if v_n <> 1 then raise exception '%: 치환 위치가 예상(1곳)과 달라요(%곳) — 중단', r.sig, v_n; end if;
            v_new := replace(v_def, 'a.pg_checkout_override', 'a.nicepay_review_access and nicepay_order_is_review_target(new.center_id, new.product_id)');
        else
            v_n := (length(v_def) - length(replace(v_def, 'ga.pg_checkout_override', ''))) / length('ga.pg_checkout_override');
            if v_n <> 1 then raise exception '%: 치환 위치가 예상(1곳)과 달라요(%곳) — 중단', r.sig, v_n; end if;
            v_new := replace(v_def, 'ga.pg_checkout_override', 'ga.nicepay_review_access and nicepay_order_is_review_target(go.center_id, go.product_id)');
            v_new := replace(v_new, 'accounts.pg_checkout_override', 'accounts.nicepay_review_access + 심사 센터 주문');   -- 설명 주석만
        end if;
        execute v_new;
        if md5(pg_get_functiondef(to_regprocedure(r.sig))) <> r.post_md5 then
            raise exception '% 치환 결과 정의 해시가 기대값과 달라요 — 트랜잭션 전체를 롤백합니다', r.sig;
        end if;
    end loop;
end $$;
commit;
