-- ============================================================
-- 수업-수강권 연결 + 수강권 예약조건 전체 초기화
--
-- 하는 일:
--   1) 모든 수업의 "예약 가능 수강권" 지정을 지움 (class_allowed_products 비움)
--   2) 모든 수강권의 예약조건을 지움 (membership_schedule_rules 비움)
--
-- 결과:
--   - 모든 수업이 "모든 수강권으로 예약 가능" 상태가 됨
--   - 요일/시간 조건이 모두 사라짐
--   → 그 뒤 수업을 다시 저장하면 올바른 조건이 새로 만들어짐
--
-- ⚠️ 주의: 되돌릴 수 없어요. 예약조건을 처음부터 다시 세팅하게 됩니다.
--   특정 센터만 초기화하려면 아래 WHERE 주석을 참고하세요.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- ============================================================

-- [1] 수업-수강권 연결 전체 삭제
delete from class_allowed_products;
-- 특정 센터만:
-- delete from class_allowed_products where class_id in
--   (select id from classes where center_id = '센터ID');

-- [2] 수강권 예약조건 전체 삭제
delete from membership_schedule_rules;
-- 특정 센터만:
-- delete from membership_schedule_rules where product_id in
--   (select id from products where center_id = '센터ID');


-- ============================================================
-- 확인
-- ============================================================
select
  (select count(*) from class_allowed_products) as 수업수강권_남은수,
  (select count(*) from membership_schedule_rules) as 예약조건_남은수;


-- ============================================================
-- 완료!
--   이제 수업 관리에서 각 수업을 다시 저장하면
--   (수강권 지정 or 미지정) 올바른 예약조건이 새로 생성됩니다.
-- ============================================================
