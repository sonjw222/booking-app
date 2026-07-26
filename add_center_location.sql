-- ============================================================
-- 우리동네 센터 - 위치 좌표
--
-- 하는 일:
--   centers 에 latitude / longitude 추가
--   → 회원 홈 "우리동네 센터"를 내 위치 기준 가까운 순으로 정렬
--   → 매니저가 센터 정보에서 "현재 위치로 설정"으로 좌표 저장
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table centers add column if not exists latitude double precision;
alter table centers add column if not exists longitude double precision;


-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns
where table_name = 'centers' and column_name in ('latitude','longitude');


-- ============================================================
-- 완료!
--   매니저: 센터 정보 → "센터에서 현재 위치로 설정" → 저장
--   회원: 홈 접속 시 위치 허용하면 가까운 센터 순으로 표시
--   ※ 좌표 미설정 센터는 뒤로 정렬돼요
-- ============================================================
