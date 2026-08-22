-- ============================================================
-- P2-11 후속: 사업자등록번호 표기(하이픈/공백 유무 등) 정규화 중복 방지
--
-- 문제: add_register_center_for_account_safe_rpc.sql에서 건 unique 인덱스는
-- business_number 원문 그대로에 걸려 있어서, "123-45-67890"과 "1234567890"처럼
-- 표기만 다르고 숫자는 같은 사업자등록번호는 여전히 둘 다 등록될 수 있었다.
--
-- 확인: 정규화(숫자만 비교) 기준 중복 진단 쿼리
-- (diagnose_business_number_format_dupes_readonly.sql) 실행 결과 기존 중복 없음
-- 확인됨(2026-08-22, "Success. No rows returned") — 아래 인덱스 교체가 기존 데이터와
-- 충돌 없이 바로 적용됨.
--
-- 참고: register_center_for_account_safe() RPC의 `exception when unique_violation`
-- 처리는 어떤 unique 인덱스가 위반됐는지와 무관하게 동작하는 범용 처리라, 이 SQL은
-- RPC 코드를 전혀 바꾸지 않아도 그대로 "이미 등록된 사업자등록번호예요" 메시지를 낸다.
--
-- DB 재생성 불필요. 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================

drop index if exists centers_business_number_unique;

create unique index if not exists centers_business_number_normalized_unique
    on centers (regexp_replace(business_number, '\D', '', 'g'))
    where business_number is not null
      and regexp_replace(business_number, '\D', '', 'g') <> '';


-- ============================================================
-- 확인
-- ============================================================
select 'centers_business_number_normalized_unique 인덱스' as 항목,
       (select count(*)::text from pg_indexes where indexname = 'centers_business_number_normalized_unique') as 값
union all
select 'centers_business_number_unique(구 인덱스, 제거 확인용)',
       (select count(*)::text from pg_indexes where indexname = 'centers_business_number_unique');
