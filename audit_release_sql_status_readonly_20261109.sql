-- 읽기 전용(SELECT 만) — 운영 SQL Editor 에서 사용자가 실행. 릴리스 후보(integration/ux-native-review-20261109)가 기대하는 DB 객체의 적용 여부를 본다. 데이터·권한을 바꾸지 않는다.
-- Claude 는 운영 DB 에 접근하지 않았다(접근 수단 없음). 아래 결과로 "미적용(false/0)" 항목만 해당 SQL 을 승인 절차에 따라 적용한다.
select 'P2 심사관 분리(add_nicepay_review_center_isolation_20261028)'      as item, (to_regprocedure('public.nicepay_review_center_allowed(uuid)') is not null) as applied
union all select 'P2b 게이트 reviewer 플래그(fix_nicepay_gate_reviewer_flag_20261029)', (to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is not null)
union all select '#265 허용 목록 테이블(add_nicepay_review_real_center_grants_20261103)', (to_regclass('public.nicepay_review_center_grants') is not null)
union all select '#265 허용 목록 RPC nicepay_my_review_center_ids()', (to_regprocedure('public.nicepay_my_review_center_ids()') is not null)
union all select '#265 쓰기 가드 nicepay_review_center_purchase_allowed(uuid)', (to_regprocedure('public.nicepay_review_center_purchase_allowed(uuid)') is not null)
union all select '횟수 선택형 가격표(add_selectable_count_pricing) — orders 트리거', exists (select 1 from pg_trigger where tgname='orders_snapshot_product_amount' and not tgisinternal)
union all select '[제안] 주문 사이즈 검증(add_orders_selected_size_validation_20261109_proposed)', exists (select 1 from pg_trigger where tgname='orders_validate_selected_size' and not tgisinternal);
-- #265 허용 행 현황(있을 때만): 정확히 1행(심사 계정 ↔ A10TION, can_purchase=false)이어야 승인된 상태.
-- select count(*) as grants, count(*) filter (where can_purchase) as purchasable from nicepay_review_center_grants;   -- 테이블이 있을 때만 실행
-- 만료 상품 숨김(fix_expired_fixed_date_products_20261031.sql)은 RPC 정의 교체라 존재 여부 쿼리로 구분되지 않는다 — 해당 SQL 자체의 preflight(정의 MD5 비교)가 적용 여부를 판단하며, 운영 적용 상태는 docs/TODO.md 기준으로 사용자가 확인한다.
