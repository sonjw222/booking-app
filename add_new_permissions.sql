-- ============================================================
-- 새 기능 권한 추가 (역할별 권한 설정에서 관리)
--
-- 그동안 추가한 기능들을 기존 카테고리에 맞춰 넣습니다:
--   시설 관리 : 룸 관리(세분화), 후기 관리
--   수강권    : 상품 관리, 주문 관리, 요일반 자동배치
--   일정      : 스케줄 복사, 보강 예약, 출결 처리
--   고객 관리 : 진도 기록, 회원 상세 조회
--   매출      : 매출 조회/등록 (이미 있으면 유지)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

insert into permissions (key, category, parent_key, label, description, sort_order) values

-- [시설 관리]
('facility.room.view',     'facility', null, '룸 조회', '센터의 룸(장소) 목록을 조회할 수 있습니다.', 51),
('facility.room.manage',   'facility', 'facility.room.view', '룸 추가·수정·삭제', '룸을 추가하거나 정보(주소·위치)를 수정하고 삭제할 수 있습니다.', 52),
('facility.review.view',   'facility', null, '후기 조회', '센터에 달린 회원 후기를 모아볼 수 있습니다.', 70),
('facility.review.reply',  'facility', 'facility.review.view', '후기 답변', '회원 후기에 센터 답변을 달거나 수정할 수 있습니다.', 71),
('facility.review.delete', 'facility', 'facility.review.view', '후기 삭제', '부적절한 후기를 삭제할 수 있습니다.', 72),
('facility.paymethod',     'facility', null, '결제수단 설정', '센터에서 받을 결제수단을 지정할 수 있습니다.', 80),

-- [수강권]
('pass.product.view',      'pass', null, '상품 조회', '대여·판매 상품 목록을 조회할 수 있습니다.', 60),
('pass.product.manage',    'pass', 'pass.product.view', '상품 추가·수정·삭제', '상품을 등록하고 설명·사이즈·가격을 수정할 수 있습니다.', 61),
('pass.order.view',        'pass', null, '주문 조회', '회원이 앱에서 넣은 주문을 조회할 수 있습니다.', 70),
('pass.order.fulfill',     'pass', 'pass.order.view', '주문 확정·발급', '주문을 확정해 수강권을 발급하고 매출에 반영할 수 있습니다.', 71),
('pass.autobook',          'pass', null, '요일반 자동배치', '요일반 수강권의 미배치 목록을 보고 다시 배치할 수 있습니다.', 80),

-- [일정]
('schedule.copy',          'schedule', null, '스케줄 복사', '한 달의 수업을 다른 달로 복사할 수 있습니다.', 60),
('schedule.makeup',        'schedule', null, '보강 예약', '수강권 조건과 무관하게 회원을 수업에 예약할 수 있습니다.', 70),
('schedule.attendance',    'schedule', null, '출결 처리', '예약자의 출석·결석·노쇼·예약취소를 처리할 수 있습니다.', 80),

-- [고객 관리]
('customer.progress.view',   'customer', null, '진도 조회', '회원의 진도 기록을 조회할 수 있습니다.', 60),
('customer.progress.manage', 'customer', 'customer.progress.view', '진도 기록·수정', '회원의 진도를 기록하고 수정·삭제할 수 있습니다.', 61),
('customer.detail',          'customer', null, '회원 상세 조회', '회원의 수강권·예약·결제·입력정보를 볼 수 있습니다.', 70)

on conflict (key) do update
    set category    = excluded.category,
        parent_key  = excluded.parent_key,
        label       = excluded.label,
        description = excluded.description,
        sort_order  = excluded.sort_order;


-- ============================================================
-- 기존 오너 역할에는 새 권한을 자동 부여
--   (오너는 모든 권한을 갖는 게 자연스러움)
-- ============================================================
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from center_roles r
cross join permissions p
where r.is_owner = true
  and p.key in (
    'facility.room.view','facility.room.manage',
    'facility.review.view','facility.review.reply','facility.review.delete',
    'facility.paymethod',
    'pass.product.view','pass.product.manage',
    'pass.order.view','pass.order.fulfill','pass.autobook',
    'schedule.copy','schedule.makeup','schedule.attendance',
    'customer.progress.view','customer.progress.manage','customer.detail'
  )
on conflict do nothing;


-- ============================================================
-- 확인
-- ============================================================
select category, count(*) as 권한수
from permissions
group by category
order by category;


-- ============================================================
-- 완료!
--   관리자 모드 → 스태프 & 권한 → 역할별 권한 설정에서 확인
-- ============================================================
