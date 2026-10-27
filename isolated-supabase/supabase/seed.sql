-- 격리 환경 카탈로그 시드(자동 생성: scripts/isolated/extractCatalogSeed.mjs). 저장소 SQL 의 INSERT 문장만 모았다 — 운영/공유 DEV 데이터 복사 아님.
-- 문장 수: {"permissions":10,"subscription_plans":1,"service_categories":2}

set session_replication_role = replica;

-- add_admin_assignment_member_status_guard.sql
insert into permissions (key, category, parent_key, label, description, sort_order) values
('customer.member.assign_any_status', 'customer', 'customer.member.view',
 '이용정지/탈퇴/휴면 회원 직접배치',
 '이용정지(휴면), 탈퇴 상태인 회원도 관리자 직접배치·무료 추가배치의 대상으로 지정할 수 있습니다. 스튜디오 오너는 이 권한 없이도 항상 가능합니다.',
 18)
on conflict (key) do nothing;

-- add_alimtalk_integration.sql
insert into permissions (key, category, parent_key, label, description, sort_order) values
('message.alimtalk.view', 'message', null, '알림톡 관리', '알림톡 발송, 자동 발송 규칙, 템플릿, 발신 설정을 관리할 수 있습니다.', 10)
on conflict (key) do nothing;

-- add_center_platform_subscription.sql
insert into subscription_plans (name, monthly_price, description, is_active)
select '기본 플랜', 0, '가격 미정 — 사업 결정 후 운영자가 조정 예정', true
where not exists (select 1 from subscription_plans) on conflict do nothing;

-- add_manager_menu_permissions.sql
insert into permissions (key, category, parent_key, label, description, sort_order) values
('pass.goods.view', 'pass', null, '상품 조회', '센터에서 판매하는 상품(용품·의류 등) 목록을 조회할 수 있습니다.', 50),
('schedule.admin_assignment_log.view', 'schedule', null, '관리자 배치 내역 조회', '관리자가 직접배치·무료 추가배치한 내역을 조회할 수 있습니다.', 90)
on conflict (key) do nothing;

-- add_membership_expiry_extension.sql
insert into permissions (key, category, parent_key, label, description, sort_order)
values (
    'customer.member.pass_expiry.update', 'customer', 'customer.member.pass_detail',
    '수강권 만료일 연장', '회원에게 발급된 수강권의 만료일을 연장할 수 있습니다.', 18
)
on conflict (key) do update set
    category = excluded.category, parent_key = excluded.parent_key,
    label = excluded.label, description = excluded.description, sort_order = excluded.sort_order;

-- add_new_permissions.sql
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

-- add_operator_settings.sql
insert into service_categories (label, emoji, sort_order) values
    ('피겨스케이팅', '⛸️', 1),
    ('필라테스', '🧘', 2),
    ('발레', '🩰', 3),
    ('리듬체조', '🤸', 4),
    ('요가', '🧎', 5),
    ('복싱', '🥊', 6),
    ('수영', '🏊', 7),
    ('골프', '⛳', 8)
on conflict (label) do nothing;

-- add_progress_categories.sql
insert into permissions (key, category, parent_key, label, description, sort_order)
values
    ('customer.progress', 'customer', null, '진도표 관리',
     '회원 진도표의 기술 목록을 편집하고 진도를 기록할 수 있습니다.', 50)
on conflict (key) do nothing;

-- add_sales.sql
insert into permissions (key, category, parent_key, label, description, sort_order)
values
    ('pass.payment.create', 'pass', null, '결제 등록', '회원 결제를 등록할 수 있습니다.', 11),
    ('pass.payment.update', 'pass', null, '결제 수정', '등록된 결제를 수정할 수 있습니다.', 12),
    ('pass.payment.delete', 'pass', null, '결제 삭제', '결제 내역을 삭제할 수 있습니다.', 13)
on conflict (key) do nothing;

-- add_tennis_category.sql
insert into service_categories (label, emoji, sort_order) values
    ('테니스', '🎾', 9)
on conflict (label) do nothing;

-- fix_restore_facility_salary_and_contract_permissions.sql
insert into permissions (key, category, parent_key, label, description, sort_order) values
('facility.salary.own.view',     'facility', 'facility.staff.view', '본인의 급여 정보 조회', '본인의 급여 정보를 조회할 수 있습니다.', 64),
('facility.salary.own.update',   'facility', 'facility.staff.view', '본인의 급여 정보 수정', '본인의 급여 정보를 수정할 수 있습니다.', 65),
('facility.salary.other.view',   'facility', 'facility.staff.view', '다른 스태프의 급여 정보 조회', '다른 스태프의 급여 정보를 조회할 수 있습니다.', 66),
('facility.salary.other.update', 'facility', 'facility.staff.view', '다른 스태프의 급여 정보 수정', '다른 스태프의 급여 정보를 수정할 수 있습니다.', 67),
('facility.salary.setting',      'facility', null, '스태프 급여 설정', '스태프의 근무 형태(정규직, 파트타임, 대강 등)에 따라 급여를 설정할 수 있습니다.', 70)
on conflict (key) do nothing;

-- fix_restore_facility_salary_and_contract_permissions.sql
insert into permissions (key, category, parent_key, label, description, sort_order) values
('contract.list.view',       'contract', null, '계약서 목록 조회', '계약서 목록을 조회 할 수 있습니다.', 10),
('contract.detail.view',     'contract', 'contract.list.view', '계약서 상세 조회', '계약서 상세 내용을 조회 할 수 있습니다.', 11),
('contract.template.view',   'contract', null, '템플릿 조회', '템플릿을 조회할 수 있습니다.', 20),
('contract.template.write',  'contract', 'contract.template.view', '템플릿 등록/수정', '템플릿을 등록 및 수정 할 수 있습니다.', 21),
('contract.template.delete', 'contract', 'contract.template.view', '템플릿 삭제', '템플릿을 삭제 할 수 있습니다.', 22),
('contract.terms.manage',    'contract', 'contract.template.view', '약관관리', '약관을 등록/수정/삭제할 수 있습니다.', 23)
on conflict (key) do nothing;

-- schema.sql
insert into permissions (key, category, parent_key, label, description, sort_order) values
-- [시설 관리]
('facility.info',            'facility', null, '시설 정보 설정', '상호, 주소, 연락처, 운영시간 등 시설의 정보를 추가 및 수정할 수 있습니다.', 10),
('facility.operation',       'facility', null, '운영정보 설정', '수업의 예약/취소시간 등 시설 운영방침에 관한 내용을 설정할 수 있습니다.', 20),
('facility.role_permission', 'facility', null, '역할별 권한설정', '역할별로 접근 권한을 설정할 수 있습니다.', 30),
('facility.notification',    'facility', null, '자동 알림 설정', '자동 알림 서비스의 발송 조건, 시점 및 문구를 조회하고 수정할 수 있습니다.', 40),
('facility.room',            'facility', null, '룸 관리 설정', '룸을 추가, 수정, 삭제하는 권한을 설정할 수 있습니다.', 50),
('facility.staff.view',      'facility', null, '스태프 조회', '스튜디오 오너, 관리자, 강사 등 스태프를 조회할 수 있습니다.', 60),
('facility.staff.create',    'facility', 'facility.staff.view', '스태프 등록', '스튜디오 오너, 관리자, 강사 등 스태프를 등록할 수 있습니다.', 61),
('facility.staff.update',    'facility', 'facility.staff.view', '스태프 정보 수정', '스튜디오 오너, 관리자, 강사 등 스태프 정보를 수정할 수 있습니다.', 62),
('facility.staff.delete',    'facility', 'facility.staff.view', '스태프 삭제', '스튜디오 오너, 매니저, 강사 등 스태프를 삭제할 수 있습니다.', 63),
('facility.salary.own.view',   'facility', 'facility.staff.view', '본인의 급여 정보 조회', '본인의 급여 정보를 조회할 수 있습니다.', 64),
('facility.salary.own.update', 'facility', 'facility.staff.view', '본인의 급여 정보 수정', '본인의 급여 정보를 수정할 수 있습니다.', 65),
('facility.salary.other.view',   'facility', 'facility.staff.view', '다른 스태프의 급여 정보 조회', '다른 스태프의 급여 정보를 조회할 수 있습니다.', 66),
('facility.salary.other.update', 'facility', 'facility.staff.view', '다른 스태프의 급여 정보 수정', '다른 스태프의 급여 정보를 수정할 수 있습니다.', 67),
('facility.salary.setting',  'facility', null, '스태프 급여 설정', '스태프의 근무 형태(정규직, 파트타임, 대강 등)에 따라 급여를 설정할 수 있습니다.', 70),

-- [고객 관리]
('customer.member.view',       'customer', null, '회원 목록 조회', '전체 회원 목록을 조회할 수 있습니다.', 10),
('customer.member.export',     'customer', 'customer.member.view', '회원 목록 엑셀 다운로드', '회원 목록을 엑셀 파일로 다운로드할 수 있습니다.', 11),
('customer.member.create',     'customer', 'customer.member.view', '회원 등록', '회원을 등록 할 수 있습니다.', 12),
('customer.member.update',     'customer', 'customer.member.view', '회원 정보 수정', '회원 정보를 수정할 수 있습니다.', 13),
('customer.member.phone',      'customer', 'customer.member.view', '회원의 휴대폰 번호 보기', '회원의 휴대폰 번호를 볼 수 있습니다.', 14),
('customer.member.delete',     'customer', 'customer.member.view', '회원 삭제', '회원을 삭제할 수 있습니다.', 15),
('customer.member.issue_pass', 'customer', 'customer.member.view', '회원에게 수강권 발급', '회원에게 수강권을 발급할 수 있습니다.', 16),
('customer.member.pass_detail','customer', 'customer.member.view', '회원의 수강권 상세정보 조회 및 수정', '회원에게 발급된 수강권 상세정보를 조회, 수정할 수 있습니다. 포인트 및 결제내역을 조회할 수 있습니다.', 17),
('customer.memo.view',   'customer', null, '회원 메모 조회', '회원에게 등록된 메모를 조회할 수 있습니다.', 20),
    ('customer.progress',    'customer', null, '진도표 관리', '회원 진도표의 기술 목록을 편집하고 진도를 기록할 수 있습니다.', 50),
('customer.memo.create', 'customer', 'customer.memo.view', '회원 메모 등록', '회원에게 메모를 등록할 수 있습니다.', 21),
('customer.memo.update', 'customer', 'customer.memo.view', '회원 메모 수정', '본인이 작성한 메모를 수정할 수 있습니다. (단, 스튜디오 오너는 모든 메모를 수정할 수 있습니다.)', 22),
('customer.memo.delete', 'customer', 'customer.memo.view', '회원 메모 삭제', '본인이 작성한 메모를 삭제할 수 있습니다. (단, 스튜디오 오너는 모든 메모를 삭제할 수 있습니다.)', 23),
('customer.lead.view',   'customer', null, '상담 고객 조회', '상담 기록, 방문 일정 등을 조회할 수 있습니다.', 30),
('customer.lead.create', 'customer', 'customer.lead.view', '상담 고객 등록', '상담 기록, 방문 일정 등을 등록할 수 있습니다.', 31),
('customer.lead.update', 'customer', 'customer.lead.view', '상담 고객 수정', '상담 기록, 방문 일정을 수정할 수 있습니다.', 32),
('customer.lead.delete', 'customer', 'customer.lead.view', '상담 고객 삭제', '상담 기록, 방문 일정을 삭제할 수 있습니다.', 33),

-- [수강권]
('pass.sales.view',     'pass', null, '매출 열람', '매출 페이지를 열람할 수 있습니다.', 10),
    ('pass.payment.create', 'pass', null, '결제 등록', '회원 결제를 등록할 수 있습니다.', 11),
    ('pass.payment.update', 'pass', null, '결제 수정', '등록된 결제를 수정할 수 있습니다.', 12),
    ('pass.payment.delete', 'pass', null, '결제 삭제', '결제 내역을 삭제할 수 있습니다.', 13),
('pass.create',         'pass', null, '수강권 등록', '새로운 수강권을 만들 수 있습니다.', 20),
('pass.update',         'pass', null, '수강권 수정', '수강권 정보를 수정할 수 있습니다.', 30),
('pass.sale_toggle',    'pass', null, '수강권 판매 정지 및 판매 재개', '수강권 판매정지를 설정 할 수 있고 판매를 재개할 수 있습니다.', 40),

-- [일정] 본인의 기타 일정
('schedule.own.etc.create', 'schedule', null, '본인의 기타 일정 등록', '기타 일정을 등록할 수 있습니다.', 10),
('schedule.own.etc.update', 'schedule', null, '본인의 기타 일정 수정', '기타 일정을 수정할 수 있습니다.', 11),
('schedule.own.etc.delete', 'schedule', null, '본인의 기타 일정 삭제', '기타 일정을 삭제할 수 있습니다.', 12),
-- 본인의 그룹 수업
('schedule.own.group.past_create',  'schedule', null, '본인의 과거 그룹 수업 등록', '과거 날짜에 그룹 수업을 등록할 수 있습니다.', 20),
('schedule.own.group.past_update',  'schedule', null, '본인의 과거 그룹 수업 수정', '과거 그룹 수업의 담당 강사를 수정할 수 있습니다.', 21),
('schedule.own.group.past_booking', 'schedule', null, '본인의 과거 그룹 수업 예약 변경', '과거 그룹 수업의 회원 예약, 출결 상태를 변경할 수 있습니다.', 22),
('schedule.own.group.past_cancel',  'schedule', null, '본인의 과거 그룹 수업 예약 취소', '과거 그룹 수업의 회원 예약을 취소할 수 있습니다.', 23),
('schedule.own.group.past_delete',  'schedule', null, '본인의 과거 그룹 수업 삭제', '과거 그룹 수업을 삭제할 수 있습니다.', 24),
('schedule.own.group.create',  'schedule', null, '본인의 그룹 수업 등록', '그룹 수업을 등록할 수 있습니다.', 25),
('schedule.own.group.update',  'schedule', null, '본인의 그룹 수업 수정', '그룹 수업의 담당 강사, 수업 시간, 최소 수강 인원을 수정할 수 있습니다.', 26),
('schedule.own.group.booking', 'schedule', null, '본인의 그룹 수업 예약 변경', '그룹 수업의 회원 예약, 출결 상태를 변경할 수 있습니다.', 27),
('schedule.own.group.cancel',  'schedule', null, '본인의 그룹 수업 예약 취소', '그룹 수업의 회원 예약을 취소할 수 있습니다.', 28),
('schedule.own.group.delete',  'schedule', null, '본인의 그룹 수업 삭제', '그룹 수업을 삭제할 수 있습니다.', 29),
-- 본인의 프라이빗 수업
('schedule.own.private.past_create',  'schedule', null, '본인의 과거 프라이빗 수업 등록', '과거 날짜에 프라이빗 수업을 등록할 수 있습니다.', 30),
('schedule.own.private.past_update',  'schedule', null, '본인의 과거 프라이빗 수업 수정', '과거 프라이빗 수업의 담당 강사, 수업 시간을 수정할 수 있습니다.', 31),
('schedule.own.private.past_booking', 'schedule', null, '본인의 과거 프라이빗 수업 예약 변경', '과거 프라이빗 수업의 회원 예약, 출결 상태를 변경할 수 있습니다.', 32),
('schedule.own.private.past_cancel',  'schedule', null, '본인의 과거 프라이빗 수업 예약 취소', '과거 프라이빗 수업의 회원 예약을 취소할 수 있습니다.', 33),
('schedule.own.private.past_delete',  'schedule', null, '본인의 과거 프라이빗 수업 삭제', '과거 프라이빗 수업을 삭제할 수 있습니다.', 34),
('schedule.own.private.create',  'schedule', null, '본인의 프라이빗 수업 등록', '프라이빗 수업을 등록할 수 있습니다.', 35),
('schedule.own.private.update',  'schedule', null, '본인의 프라이빗 수업 수정', '프라이빗 수업의 담당 강사, 수업 시간을 수정할 수 있습니다.', 36),
('schedule.own.private.booking', 'schedule', null, '본인의 프라이빗 수업 예약 변경', '프라이빗 수업의 회원 예약, 출결 상태를 변경할 수 있습니다.', 37),
('schedule.own.private.cancel',  'schedule', null, '본인의 프라이빗 수업 예약 취소', '프라이빗 수업의 회원 예약을 취소할 수 있습니다.', 38),
('schedule.own.private.delete',  'schedule', null, '본인의 프라이빗 수업 삭제', '프라이빗 수업을 삭제할 수 있습니다.', 39),
-- 다른 스태프의 그룹 수업
('schedule.other.group.view', 'schedule', null, '다른 스태프의 그룹 수업 조회', '그룹 수업을 조회할 수 있습니다.', 40),
('schedule.other.group.past_create',  'schedule', 'schedule.other.group.view', '다른 스태프의 과거 그룹 수업 등록', '과거 날짜에 그룹 수업을 등록할 수 있습니다.', 41),
('schedule.other.group.past_update',  'schedule', 'schedule.other.group.view', '다른 스태프의 과거 그룹 수업 수정', '과거 그룹 수업의 담당 강사를 수정할 수 있습니다.', 42),
('schedule.other.group.past_booking', 'schedule', 'schedule.other.group.view', '다른 스태프의 과거 그룹 수업 예약 변경', '과거 그룹 수업의 회원 예약, 출결 상태를 변경할 수 있습니다.', 43),
('schedule.other.group.past_cancel',  'schedule', 'schedule.other.group.view', '다른 스태프의 과거 그룹 수업 예약 취소', '과거 그룹 수업의 회원 예약을 취소할 수 있습니다.', 44),
('schedule.other.group.past_delete',  'schedule', 'schedule.other.group.view', '다른 스태프의 과거 그룹 수업 삭제', '과거 그룹 수업을 삭제할 수 있습니다.', 45),
('schedule.other.group.create',  'schedule', 'schedule.other.group.view', '다른 스태프의 그룹 수업 등록', '그룹 수업을 등록할 수 있습니다.', 46),
('schedule.other.group.update',  'schedule', 'schedule.other.group.view', '다른 스태프의 그룹 수업 수정', '그룹 수업의 담당 강사, 수업 시간, 최소 수강 인원을 수정할 수 있습니다.', 47),
('schedule.other.group.booking', 'schedule', 'schedule.other.group.view', '다른 스태프의 그룹 수업 예약 변경', '그룹 수업의 회원 예약, 출결 상태를 변경할 수 있습니다.', 48),
('schedule.other.group.cancel',  'schedule', 'schedule.other.group.view', '다른 스태프의 그룹 수업 예약 취소', '그룹 수업의 회원 예약을 취소할 수 있습니다.', 49),
('schedule.other.group.delete',  'schedule', 'schedule.other.group.view', '다른 스태프의 그룹 수업 삭제', '그룹 수업을 삭제할 수 있습니다.', 50),
-- 다른 스태프의 프라이빗 수업
('schedule.other.private.view', 'schedule', null, '다른 스태프의 프라이빗 수업 조회', '프라이빗 수업을 조회할 수 있습니다.', 60),
('schedule.other.private.past_create',  'schedule', 'schedule.other.private.view', '다른 스태프의 과거 프라이빗 수업 등록', '과거 날짜에 프라이빗 수업을 등록할 수 있습니다.', 61),
('schedule.other.private.past_update',  'schedule', 'schedule.other.private.view', '다른 스태프의 과거 프라이빗 수업 수정', '과거 프라이빗 수업의 담당 강사, 수업 시간을 수정할 수 있습니다.', 62),
('schedule.other.private.past_booking', 'schedule', 'schedule.other.private.view', '다른 스태프의 과거 프라이빗 수업 예약 변경', '과거 프라이빗 수업의 회원 예약, 출결 상태를 변경할 수 있습니다.', 63),
('schedule.other.private.past_cancel',  'schedule', 'schedule.other.private.view', '다른 스태프의 과거 프라이빗 수업 예약 취소', '과거 프라이빗 수업의 회원 예약을 취소할 수 있습니다.', 64),
('schedule.other.private.past_delete',  'schedule', 'schedule.other.private.view', '다른 스태프의 과거 프라이빗 수업 삭제', '과거 프라이빗 수업을 삭제할 수 있습니다.', 65),
('schedule.other.private.create',  'schedule', 'schedule.other.private.view', '다른 스태프의 프라이빗 수업 등록', '프라이빗 수업을 등록할 수 있습니다.', 66),
('schedule.other.private.update',  'schedule', 'schedule.other.private.view', '다른 스태프의 프라이빗 수업 수정', '프라이빗 수업의 담당 강사, 수업 시간을 수정할 수 있습니다.', 67),
('schedule.other.private.booking', 'schedule', 'schedule.other.private.view', '다른 스태프의 프라이빗 수업 예약 변경', '프라이빗 수업의 회원 예약, 출결 상태를 변경할 수 있습니다.', 68),
('schedule.other.private.cancel',  'schedule', 'schedule.other.private.view', '다른 스태프의 프라이빗 수업 예약 취소', '프라이빗 수업의 회원 예약을 취소할 수 있습니다.', 69),
('schedule.other.private.delete',  'schedule', 'schedule.other.private.view', '다른 스태프의 프라이빗 수업 삭제', '프라이빗 수업을 삭제할 수 있습니다.', 70),
-- 일정 메모
('schedule.memo.create', 'schedule', null, '메모 등록', '일정 상세페이지에 메모를 등록할 수 있습니다.', 80),
('schedule.memo.update', 'schedule', 'schedule.memo.create', '메모 수정', '본인이 작성한 메모를 수정할 수 있습니다. (단, 스튜디오 오너는 모든 메모를 수정할 수 있습니다.)', 81),
('schedule.memo.delete', 'schedule', 'schedule.memo.create', '메모 삭제', '본인이 작성한 메모를 삭제할 수 있습니다. (단, 스튜디오 오너는 모든 메모를 삭제할 수 있습니다.)', 82),

-- [게시판]
('board.notice.view',   'board', null, '공지사항 조회', '공지사항을 조회할 수 있습니다.', 10),
('board.notice.write',  'board', 'board.notice.view', '공지사항 등록, 수정', '공지사항을 등록, 수정할 수 있습니다.', 11),
('board.notice.delete', 'board', 'board.notice.view', '공지사항 삭제', '공지사항을 삭제할 수 있습니다.', 12),
('board.inquiry.view',  'board', null, '문의사항 조회', '문의 게시판을 조회할 수 있습니다.', 20),
('board.inquiry.comment',      'board', 'board.inquiry.view', '문의 게시판에 댓글 등록, 수정, 삭제', '문의 게시판에 댓글을 등록, 수정, 삭제 할 수 있습니다.', 21),
('board.inquiry.comment_other','board', 'board.inquiry.view', '문의 게시판의 다른 스태프 댓글 삭제', '문의 게시판에 다른 스태프가 등록한 댓글을 삭제할 수 있습니다.', 22),

-- [메시지]
('message.sms.view',   'message', null, '문자 메시지 조회', '문자 메시지를 조회할 수 있습니다.', 10),
('message.sms.send',   'message', 'message.sms.view', '문자 메시지 보내기', '문자 메시지를 보낼 수 있습니다.', 11),
('message.sms.update', 'message', 'message.sms.view', '문자 메시지 수정 및 예약 취소', '문자 메시지를 수정하거나 예약된 메시지를 취소 할 수 있습니다.', 12),
('message.sms.delete', 'message', 'message.sms.view', '문자 메시지 삭제', '문자 메시지를 삭제 할 수 있습니다.', 13),
('message.push.view',   'message', null, '앱 푸시 메시지 조회', '앱 푸시 메시지를 조회할 수 있습니다.', 20),
('message.push.send',   'message', 'message.push.view', '앱 푸시 메시지 보내기', '앱 푸시 메시지를 보낼 수 있습니다.', 21),
('message.push.update', 'message', 'message.push.view', '앱 푸시 메시지 수정 및 예약 취소', '앱 푸시 메시지를 수정하거나, 예약된 메시지를 취소할 수 있습니다.', 22),
('message.push.delete', 'message', 'message.push.view', '앱 푸시 메시지 삭제', '앱 푸시 메시지를 삭제할 수 있습니다.', 23),

-- [전자계약서]
('contract.list.view',   'contract', null, '계약서 목록 조회', '계약서 목록을 조회 할 수 있습니다.', 10),
('contract.detail.view', 'contract', 'contract.list.view', '계약서 상세 조회', '계약서 상세 내용을 조회 할 수 있습니다.', 11),
('contract.template.view',   'contract', null, '템플릿 조회', '템플릿을 조회할 수 있습니다.', 20),
('contract.template.write',  'contract', 'contract.template.view', '템플릿 등록/수정', '템플릿을 등록 및 수정 할 수 있습니다.', 21),
('contract.template.delete', 'contract', 'contract.template.view', '템플릿 삭제', '템플릿을 삭제 할 수 있습니다.', 22),
('contract.terms.manage',    'contract', 'contract.template.view', '약관관리', '약관을 등록/수정/삭제할 수 있습니다.', 23) on conflict do nothing;

-- ── 이후 저장소 migration 이 명시적으로 지운 권한 키 ──
-- add_schedule_permission_completion.sql
delete from permissions where key in ('schedule.other.group.create', 'schedule.other.private.create');

-- fix_customer_permission_cleanup.sql
delete from permissions
where key in ('customer.progress.view', 'customer.progress.manage', 'customer.detail');

-- fix_pass_product_permission_cleanup.sql
delete from permissions where key in ('pass.product.view', 'pass.product.manage');

set session_replication_role = origin;
