-- 롤백: fix_business_number_normalize_unique.sql
-- 주의: 정규화 unique 인덱스를 지우고 원문 기준 인덱스로 되돌립니다.
-- (표기만 다른 중복 사업자등록번호가 다시 등록 가능해집니다.)

drop index if exists centers_business_number_normalized_unique;

create unique index if not exists centers_business_number_unique
    on centers (business_number)
    where business_number is not null and business_number <> '';
