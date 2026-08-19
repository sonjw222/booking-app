-- ============================================================
-- P1-5 나머지: 상품/후기/주문/관리자배치내역 4개 메뉴에 권한 key 연결
--
-- 조사 결과 4개 중 2개는 이미 카탈로그에 키가 있었는데(add_new_permissions.sql) 화면
-- 메뉴에 연결이 안 돼 있었다 — 그대로 재사용:
--   - facility.review.view (후기 관리)
--   - pass.order.view (주문 관리)
-- 나머지 2개는 새로 추가한다:
--   - pass.goods.view (상품 관리)
--   - schedule.admin_assignment_log.view (관리자 배치 내역)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

insert into permissions (key, category, parent_key, label, description, sort_order) values
('pass.goods.view', 'pass', null, '상품 조회', '센터에서 판매하는 상품(용품·의류 등) 목록을 조회할 수 있습니다.', 50),
('schedule.admin_assignment_log.view', 'schedule', null, '관리자 배치 내역 조회', '관리자가 직접배치·무료 추가배치한 내역을 조회할 수 있습니다.', 90)
on conflict (key) do nothing;
