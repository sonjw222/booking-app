-- ============================================================
-- 프로필 추가 정보 (옷 사이즈 / 주소)
--
-- 회원이 마이페이지에서 직접 입력 → 관리자 회원관리에서 조회
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table profiles add column if not exists cloth_size text;
alter table profiles add column if not exists address text;


-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns
where table_name = 'profiles' and column_name in ('shoe_size','cloth_size','address');


-- ============================================================
-- 완료!
-- ============================================================
