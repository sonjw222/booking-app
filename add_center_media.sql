-- ============================================================
-- 센터 프로필 사진 + SNS
--
-- 하는 일:
--   centers 에 photo_url / sns 컬럼 추가
--   (사진은 avatars 버킷 재사용 - 이미 만들었으면 추가 작업 없음)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table centers add column if not exists photo_url text;
alter table centers add column if not exists sns text;


-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns
where table_name = 'centers' and column_name in ('photo_url','sns');


-- ============================================================
-- 완료!
--   매니저: 센터 정보 → 사진 + SNS(한 줄에 하나씩) 입력
--   회원: 센터 상세 화면에 사진·SNS 표시
-- ============================================================
