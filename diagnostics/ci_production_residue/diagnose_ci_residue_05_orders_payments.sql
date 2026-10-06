-- READ ONLY / PRODUCTION SAFE DIAGNOSTIC / NO MUTATION
-- 2026-10-07 — CI(GitHub Actions) E2E/integration이 Production Supabase에서 실행됐을 가능성에 대한 재진단. SELECT만 포함한다(INSERT/UPDATE/DELETE/DDL 없음).
-- 사용법: Supabase SQL Editor에서 이 파일 전체를 "하나만" 실행하고 결과를 확인한 뒤 다음 번호 파일로 넘어간다. 결과가 0행이면 해당 범위에 잔여물이 없다.
-- 패턴은 tests/e2e, tests/integration 코드가 실제로 만드는 이름만 사용한다(추측 prefix 없음). 의도적 운영 데이터([QA]/[토스 심사용] 센터, 심사 계정)는 패턴에 넣지 않았다.
-- created_at 날짜별 집계(day)로 보여 주므로, 이전에 정리한 시점 이후 날짜에 나타난 행만 "새 잔여물"로 본다.
-- 05) 주문/결제: 테스트 상품명으로 생성된 주문(E2E 직접결제 등)과 연결된 결제. 상품 삭제 후에도 주문 스냅샷(product_name)으로 남을 수 있다.
select o.id::text as order_id, o.product_name, o.amount, o.status::text as status, o.pay_method, o.payment_provider, o.created_at::date as day,
       (select count(*) from public.payments p where p.order_id = o.id) as payment_rows
  from public.orders o
 where o.product_name like 'E2E %' or o.product_name like 'P3 %' or o.product_name like 'TEST4 %' or o.product_name like '통합테스트 수강권%'
    or o.product_name like 'CLASS-REV 테스트상품-%' or o.product_name like 'QA-상품-%' or o.product_name like 'QA-레거시상품-%'
 order by day desc, o.product_name;
-- 기대: 실제 고객 주문이 아니므로 amount가 작거나 테스트 상품명이다. 'E2E 실토스결제창 테스트 수강권'/'E2E 직접결제 테스트 수강권' 주문은 해당 E2E 실행 흔적이다.
