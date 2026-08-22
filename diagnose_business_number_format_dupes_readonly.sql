-- 읽기 전용 진단 쿼리 (P2-11 후속) — 아무것도 변경하지 않습니다.
-- Supabase SQL Editor에서 실행 후 결과를 그대로 붙여넣어 주세요.
--
-- 목적: business_number 표기(하이픈/공백 유무 등)만 다르고 실제로는 같은 번호인
-- 행이 있는지 확인 — 있으면 정규화(숫자만 비교) 기준 unique 인덱스를 걸기 전에
-- 먼저 정리가 필요합니다.

select
  regexp_replace(business_number, '\D', '', 'g') as normalized,
  count(*) as cnt,
  array_agg(id) as center_ids,
  array_agg(business_number) as raw_values
from centers
where business_number is not null and business_number <> ''
group by regexp_replace(business_number, '\D', '', 'g')
having count(*) > 1;
