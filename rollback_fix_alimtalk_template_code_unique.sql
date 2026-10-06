-- fix_alimtalk_template_code_unique.sql 롤백: 해당 unique index 하나만 제거한다. 데이터는 변경하지 않는다.
-- 주의: 롤백하면 같은 aligo_template_code 가 서로 다른 행(센터/공통)에 동시에 생기는 것을 DB가 다시 막지 못한다(클라이언트 목록 검사만 남음).
drop index if exists public.idx_alimtalk_templates_aligo_code_unique;
