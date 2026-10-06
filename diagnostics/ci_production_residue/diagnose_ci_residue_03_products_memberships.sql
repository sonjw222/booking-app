-- READ ONLY / PRODUCTION SAFE DIAGNOSTIC / NO MUTATION
-- 2026-10-07 — CI(GitHub Actions) E2E/integration이 Production Supabase에서 실행됐을 가능성에 대한 재진단. SELECT만 포함한다(INSERT/UPDATE/DELETE/DDL 없음).
-- 사용법: Supabase SQL Editor에서 이 파일 전체를 "하나만" 실행하고 결과를 확인한 뒤 다음 번호 파일로 넘어간다. 결과가 0행이면 해당 범위에 잔여물이 없다.
-- 패턴은 tests/e2e, tests/integration 코드가 실제로 만드는 이름만 사용한다(추측 prefix 없음). 의도적 운영 데이터([QA]/[토스 심사용] 센터, 심사 계정)는 패턴에 넣지 않았다.
-- created_at 날짜별 집계(day)로 보여 주므로, 이전에 정리한 시점 이후 날짜에 나타난 행만 "새 잔여물"로 본다.
-- 03) 상품/수강권: 테스트가 만드는 상품 이름과 그 상품으로 발급된 수강권 수.
select 'product' as kind, pr.id::text as id, pr.name as label, pr.center_id::text as center_id, pr.created_at::date as day,
       (select count(*) from public.memberships m where m.product_id = pr.id)::text as membership_count
  from public.products pr
 where pr.name like 'E2E %' or pr.name like 'P3 %' or pr.name like 'TEST4 %' or pr.name like '통합테스트 수강권%'
    or pr.name like 'CLASS-REV 테스트상품-%' or pr.name like 'QA-상품-%' or pr.name like 'QA-레거시상품-%' or pr.name like 'QA-B등급-%' or pr.name like 'QA-경계-%'
 order by day desc, label;
-- 기대: 정상 종료된 실행은 afterAll에서 삭제한다. 최근 날짜 행이 있으면 정리되지 않은 잔여물이다.
