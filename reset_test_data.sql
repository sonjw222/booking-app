-- ============================================================
-- 테스트 데이터 초기화 (센터/수업/수강권/예약 전부 삭제)
--
-- 언제 쓰나요?
--   · seed_data.sql 을 두 번 이상 실행해서 데이터가 중복됐을 때
--   · 테스트 데이터를 깨끗이 지우고 처음부터 다시 하고 싶을 때
--
-- 무엇이 지워지나요?
--   센터에 딸린 모든 데이터 (수업, 수강권, 예약, 역할, 설정 등)
--   ※ 회원가입한 계정(accounts/profiles)은 그대로 남습니다.
--     → 다시 가입할 필요 없이 바로 seed_data.sql 재실행 가능
--
-- 사용법: 이 파일 전체를 복사해서 Supabase SQL Editor에 붙여넣고 Run
-- ============================================================


-- truncate + cascade 는 외래키로 연결된 자식 테이블까지
-- 알아서 순서대로 비워줍니다. (delete 처럼 순서 신경 안 써도 됨)
truncate table centers cascade;

-- centers 와 직접 연결되지 않은 나머지 테스트 데이터도 정리
truncate table memberships cascade;
truncate table reservations cascade;
truncate table payments cascade;


-- ============================================================
-- 완료!
--
-- 다음 순서:
--   1) seed_data.sql 을 딱 한 번만 실행
--   2) 앱에서 /reservation 새로고침 → 7/14에 수업 3개가 보이면 성공
--
-- 확인용 쿼리:
--   select count(*) from centers;      -- 2 (어텐션 피겨팀, 올림픽 스포츠수영)
--   select count(*) from classes;      -- 6
--   select count(*) from memberships;  -- 2
-- ============================================================
