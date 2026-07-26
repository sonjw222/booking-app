-- ============================================================
-- 운동센터 통합 예약앱 - 데이터베이스 설계 (Supabase/PostgreSQL)
-- 하이파이브 + 스튜디오메이트 + 다짐 장점을 참고해 만든 스키마
-- ============================================================
-- 사용법: Supabase 대시보드 > SQL Editor 에 이 파일 내용을 붙여넣고 실행하면
--        아래 모든 테이블이 한 번에 만들어집니다.
-- ============================================================


-- ------------------------------------------------------------
-- 0. 확장 기능 켜기 (uuid 자동 생성을 위해 필요)
-- ------------------------------------------------------------
create extension if not exists "pgcrypto";


-- ------------------------------------------------------------
-- 1. 센터 테이블 (필라테스샵, 헬스장 등 하나의 운동시설)
-- ------------------------------------------------------------
create table centers (
    id              uuid primary key default gen_random_uuid(),  -- 센터 고유번호 (자동생성)
    name            text not null,                                -- 센터 이름 (예: "강남 필라테스")
    categories      text[] not null default '{}',                 -- 종목들 (필라테스/발레/피겨 등, 중복 가능, 홈 필터용)
    address         text,                                         -- 주소
    phone           text,                                         -- 센터 대표번호
    intro           text,                                         -- 센터 소개글 (구버전, 하위호환용)
    intro_blocks    jsonb not null default '[]',                  -- 센터 소개 (블로그식: [{type:'text'|'image', value}])
    pay_methods     text[],                                       -- 허용 결제수단 (null이면 전체 허용)
    photo_url       text,                                         -- 센터 프로필 사진 (Storage 경로, 선택)
    sns             text,                                         -- SNS 정보 (여러 줄 자유 입력, 선택)
    latitude        numeric(9,6),                                 -- 위도 (지도/길찾기 기능용)
    longitude       numeric(9,6),                                 -- 경도 (지도/길찾기 기능용)
    business_number text,                                         -- 사업자등록번호 (매니저 가입 시 필수)
    business_license_url text,                                    -- 사업자등록증 파일 (Storage 경로, 필수)
    -- 승인 흐름: 가입 후 승인대기 → 운영자가 사업자등록증 확인 후 approved
    --            pending 상태에서는 회원에게 센터/수업이 노출되지 않음
    status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected')),
    reject_reason   text,                                         -- 반려 시 사유
    -- 센터별로 허용할 결제방식 선택 (예: 카드만 받고 무통장은 안 받는 경우)
    payment_methods text[] not null default '{card,transfer,onsite}',
                    -- card(카드결제) / transfer(무통장입금) / onsite(현장결제)
    created_at      timestamptz not null default now()            -- 등록일시
);

comment on column centers.status is '가입 후 승인대기. approved 되어야 회원에게 노출됨';
comment on column centers.payment_methods is '이 센터가 받는 결제방식 목록';

comment on table centers is '운동센터/스튜디오 정보 (필라테스샵, 헬스장 등)';


-- ------------------------------------------------------------
-- 2. 계정 / 프로필 / 매니저-센터 (3계층 구조)
--
--   [accounts] 로그인 단위 (이메일/소셜 1개)
--       ├─ 회원 역할: [profiles] 프로필 여러 개 (본인/추가 프로필...)
--       └─ 매니저 역할: [manager_centers] 운영하는 센터 (강사도 여기 포함)
--
--   한 계정이 회원 + 매니저를 동시에 가질 수 있고,
--   마이페이지에서 모드를 전환함.
-- ------------------------------------------------------------

-- (2-1) 계정: 로그인하는 사람 1명 = 1행
create table accounts (
    id              uuid primary key default gen_random_uuid(),
    auth_id         uuid unique not null,                         -- Supabase Auth 계정과 연결
    name            text not null,                                -- 가입자 본인 이름
    phone           text unique,                                  -- 휴대폰번호
    address         text,                                         -- 주소 (선택, 회원 검색용)
    is_member       boolean not null default true,                -- 회원 역할 사용 여부
    is_manager      boolean not null default false,               -- 매니저 역할 사용 여부
    -- 플랫폼 운영자(우리 서비스 운영진). 센터 가입 승인/반려 권한을 가짐.
    -- 일반 가입으로는 절대 true가 되지 않고, DB에서 직접 부여함.
    is_platform_admin boolean not null default false,
    created_at      timestamptz not null default now()
);

comment on table accounts is '로그인 단위. is_member/is_manager로 어떤 역할을 쓸 수 있는지 표시';

-- (2-2) 프로필: 회원 역할 안에서 실제로 수업을 듣는 주체
--       가입하면 본인 프로필 1개가 기본 생성되고, 프로필을 추가하면 행이 늘어남.
--       예약/수강권/출석/진도는 전부 "프로필" 단위로 연결됨.
create table profiles (
    id              uuid primary key default gen_random_uuid(),
    account_id      uuid not null references accounts(id),        -- 이 프로필을 관리하는 계정
    name            text not null,                                -- 프로필 이름 (예: "손장욱")
    label           text,                                         -- 프로필 구분 라벨 (자유 입력, 선택)
    birth_date      date,                                         -- 생년월일 (선택)
    cloth_size      text,                                         -- 옷 사이즈 (선택)
    address         text,                                         -- 주소 (선택, 회원 입력)
    is_primary      boolean not null default false,               -- 계정 본인 프로필인지
    created_at      timestamptz not null default now()
);

comment on table profiles is '회원 역할의 실제 수강 주체(본인 및 추가 프로필). 예약/수강권/진도는 이 프로필에 연결';

-- (2-3) 센터 역할: 기본 3개(스튜디오오너/매니저/강사) + 오너가 자유롭게 추가 가능
--       센터를 만들면 기본 역할 3개가 자동 생성됨 (아래 트리거)
create table center_roles (
    id              uuid primary key default gen_random_uuid(),
    center_id       uuid not null references centers(id),
    name            text not null,                                -- '스튜디오 오너' / '매니저' / '강사' / 커스텀
    role_key        text,                                         -- 'owner'/'manager'/'trainer' (기본역할 식별용), 커스텀은 NULL
    is_system       boolean not null default false,               -- 기본 역할이면 true (삭제 불가)
    is_owner        boolean not null default false,               -- 오너 역할이면 true (모든 권한 자동 보유)
    sort_order      int not null default 0,
    created_at      timestamptz not null default now(),
    unique (center_id, name)
);

comment on table center_roles is '센터별 관리자 역할. 스튜디오 오너가 새 역할을 추가할 수 있음';

-- (2-4) 역할별 권한: 오너가 각 역할에 권한을 부여
--       is_owner=true 역할은 이 표와 무관하게 모든 권한을 가짐
--       ※ 권한 키 목록은 스튜디오메이트 참조해서 확정 예정 (아래는 초안)
create table role_permissions (
    id              uuid primary key default gen_random_uuid(),
    role_id         uuid not null references center_roles(id) on delete cascade,
    permission_key  text not null,                                -- permissions.key 참조 (FK는 permissions 정의 후 아래에서 추가)
    unique (role_id, permission_key)
);


-- ------------------------------------------------------------
-- 4-3. 개인별 권한 예외 (역할 위에 덮어쓰기)
--   같은 사람이라도 센터마다 다를 수 있으므로 manager_centers 에 매닮.
--   판정: 오너면 전권 → deny면 차단 → allow면 허용 → 없으면 역할 따름
-- ------------------------------------------------------------
create table account_center_permissions (
    id                 uuid primary key default gen_random_uuid(),
    manager_center_id  uuid not null,                             -- manager_centers(id). FK는 아래에서 추가(정의 순서 때문)
    permission_key     text not null,                             -- permissions.key 참조 (FK 아래에서 추가)
    grant_type         text not null check (grant_type in ('allow', 'deny')),
    created_at         timestamptz not null default now(),
    unique (manager_center_id, permission_key)
);

comment on table account_center_permissions is '개인별 권한 예외. allow=역할에 없어도 부여, deny=역할에 있어도 차단';


-- ------------------------------------------------------------
-- 4-2. 권한 카탈로그 (스튜디오메이트 권한설정 화면 그대로)
--      권한설정 화면은 이 표를 읽어서 자동으로 그려짐.
--      parent_key 로 중첩(상위 권한 해제 시 하위도 해제).
-- ------------------------------------------------------------
create table permissions (
    key         text primary key,                                 -- 예: 'facility.staff.view'
    category    text not null                                     -- 화면 상단 탭
                check (category in ('facility','customer','pass','schedule','board','message','contract')),
    parent_key  text references permissions(key),                 -- 상위 권한 (없으면 최상위)
    label       text not null,                                    -- 화면에 보일 이름
    description text,                                             -- 설명 문구
    sort_order  int not null default 0
);

comment on table permissions is '역할별 권한설정 화면을 구성하는 권한 목록 (고정 카탈로그)';

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
('contract.terms.manage',    'contract', 'contract.template.view', '약관관리', '약관을 등록/수정/삭제할 수 있습니다.', 23);

-- role_permissions.permission_key 외래키 (permissions 정의·데이터 삽입 이후에 추가)
--   FK로 묶어야 오타난 권한키가 들어가는 걸 DB가 막아줌
alter table role_permissions
    add constraint role_permissions_key_fk
    foreign key (permission_key) references permissions(key) on delete cascade;


comment on table role_permissions is '역할에 부여된 권한. 오너가 매니저/강사/커스텀 역할에 권한 지정';

-- (2-5) 매니저-센터: 한 계정이 운영/근무하는 센터 + 그 센터에서의 역할
create table manager_centers (
    id              uuid primary key default gen_random_uuid(),
    account_id      uuid not null references accounts(id),        -- 매니저/강사 계정
    center_id       uuid not null references centers(id),         -- 담당 센터
    role_id         uuid references center_roles(id),             -- 이 센터에서의 역할
    specialty       text,                                         -- 강사인 경우 담당 종목
    -- 승인 흐름: 오너가 초대/승인해야 활성화 (센터 가입 신청 후 승인대기)
    status          text not null default 'pending'
                    check (status in ('pending', 'active', 'suspended')),
    created_at      timestamptz not null default now(),
    unique (account_id, center_id)
);

comment on table manager_centers is '계정이 운영/근무하는 센터와 그 센터에서의 역할';


-- ------------------------------------------------------------
-- 3. 수업 테이블 (센터에서 개설하는 클래스)
-- ------------------------------------------------------------
-- ------------------------------------------------------------
-- 5-0. 룸 (수업이 진행되는 공간)
--      같은 시간대에 한 룸에서 여러 수업이 가능(중복 허용)
-- ------------------------------------------------------------
create table rooms (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    name        text not null,                                  -- 예: "A룸", "1번 링크"
    capacity    int,                                            -- 룸 최대 수용 인원 (참고용)
    is_active   boolean not null default true,
    sort_order  int not null default 0,
    created_at  timestamptz not null default now()
);

comment on table rooms is '센터의 룸. 수업 장소로 사용 (권한: facility.room)';


-- ------------------------------------------------------------
-- 5-0-1. 수업 구분 (설정 > 수업 구분 설정)
--        예: "어텐션 정규반", "어텐션 원데이 안무반", "어텐션 파티"
--        수강권 종류별로 예약 가능한 수업 구분이 달라짐
-- ------------------------------------------------------------
create table class_types (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    name        text not null,
    sort_order  int not null default 0,
    is_active   boolean not null default true,
    unique (center_id, name)
);

comment on table class_types is '센터가 정의하는 수업 구분. classes.class_type_id로 연결';


-- ------------------------------------------------------------
-- 5-0-2. 센터 운영정보 설정 (설정 > 운영정보, 17개 항목)
--        센터당 1행. 예약/취소 규칙의 기본값이 여기서 나옴
-- ------------------------------------------------------------
create table center_settings (
    center_id   uuid primary key references centers(id),

    -- 01. 예약·취소 가능 시간 (프라이빗/그룹 각각)
    --     "수업 시작 N일 전 HH:MM 까지 예약 가능"
    private_book_days_before   int not null default 1,
    private_book_time          time not null default '22:00',
    group_book_days_before     int not null default 1,
    group_book_time            time not null default '22:00',
    private_cancel_days_before int not null default 1,
    private_cancel_time        time not null default '22:00',
    group_cancel_days_before   int not null default 1,
    group_cancel_time          time not null default '22:00',

    -- 02. 당일 예약 변경 가능 시간 (그룹 수업, 시작 N시간 M분 전까지)
    allow_same_day_booking  boolean not null default true,          -- 당일 예약 허용 여부
    same_day_change_hours   int not null default 24,
    same_day_change_minutes int not null default 0,

    -- 03. 수업 폐강 시간 (최소 수강인원 미달 시 시작 N시간 M분 전 폐강)
    autocancel_hours   int not null default 0,
    autocancel_minutes int not null default 0,

    -- 04. 예약대기 자동 예약 시간 (공석 발생 시 시작 N시간 M분 전까지 자동 예약)
    --     미설정 시 '취소 가능한 시간'으로 적용
    waitlist_auto_hours   int not null default 0,
    waitlist_auto_minutes int not null default 0,

    -- 05. 예약 대기 가능 횟수 (한 주간 그룹수업 최대 N회. 0이면 대기 기능 사용 불가)
    waitlist_weekly_limit int not null default 0,

    -- 06. 일일 예약 가능 횟수
    daily_book_limit_enabled boolean not null default false,
    daily_book_limit         int,

    -- 07. 예약 가능 기한 (수업일 기준 N일 전 HH:MM 부터 예약 오픈)
    private_open_days_before int not null default 60,
    private_open_time        time not null default '15:00',
    group_open_days_before   int not null default 60,
    group_open_time          time not null default '15:00',

    -- 08. 프라이빗 수업 예약 시간 단위 (정시/30/20/15/10/5분)
    private_slot_unit text not null default '30min'
                      check (private_slot_unit in ('hour','30min','20min','15min','10min','5min')),

    -- 09. 프라이빗 수업 생성 최대 개수 (같은 시간대)
    private_max_concurrent_enabled boolean not null default false,
    private_max_concurrent         int,

    -- 10. 그룹 수업 예약/대기 인원 표시 여부 (회원 앱)
    show_group_reserved_count boolean not null default true,
    show_group_waitlist_count boolean not null default true,

    -- 11~17. 기능 사용 여부
    use_inquiry_board    boolean not null default true,   -- 11. 문의 게시판
    show_all_classes     boolean not null default true,   -- 12. 수강권으로 볼 수 없는 수업도 표시
    use_locker           boolean not null default false,  -- 13. 락커 기능
    deduct_on_late_cancel boolean not null default false, -- 14. 취소 가능 시간 후 취소 시 횟수 차감
    auto_unpaid_input    boolean not null default false,  -- 15. 수강권 미수금 자동 입력
    use_lounge           boolean not null default true,   -- 16. 회원앱 라운지
    show_point_history   boolean not null default true,   -- 17. 회원앱 포인트 내역 조회

    updated_at timestamptz not null default now()
);

comment on table center_settings is '센터별 운영 규칙(설정>운영정보 17개 항목). 예약/취소/폐강/대기 기본값';
comment on column center_settings.deduct_on_late_cancel is '취소 가능 시간이 지난 후 취소하면 횟수가 차감되며 취소됨';


-- ------------------------------------------------------------
-- 5-0-3. 락커 (설정 > 락커 사용 시)
-- ------------------------------------------------------------
create table lockers (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    name        text not null,                              -- 예: "A-01"
    is_active   boolean not null default true,
    unique (center_id, name)
);

create table locker_assignments (
    id          uuid primary key default gen_random_uuid(),
    locker_id   uuid not null references lockers(id),
    profile_id  uuid not null references profiles(id),
    starts_at   date not null default current_date,
    expires_at  date not null,                              -- 회원 탭에 만료일 표시
    created_at  timestamptz not null default now()
);

comment on table locker_assignments is '회원별 락커 배정. 회원 탭에 사용중 락커·만료일 표시';


create table classes (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),         -- 어느 센터의 수업인지
    title       text not null,                                 -- 수업명 (예: "저녁 필라테스 그룹반")
    description text,                                          -- 수업 소개
    -- 수업 형태: group(그룹 수업) / private(프라이빗 1:1)  ← 권한·정원 규칙이 다름
    class_format text not null default 'group'
                check (class_format in ('group', 'private')),
    class_type_id uuid references class_types(id),             -- 수업구분 (설정>수업 구분 설정). 수강권 종류별로 고를 수 있는 수업이 달라짐
    room_id     uuid references rooms(id),                     -- 룸 (같은 시간 한 룸에 여러 수업 가능 → 중복 허용)
    place       text,                                          -- 장소 텍스트 (룸 미사용 시)
    -- 반복수업 그룹 (같은 반복 등록으로 생성된 수업들은 같은 id). 단발 수업은 null
    recurring_group_id uuid,
    start_time  timestamptz not null,                          -- 수업 시작 시각
    end_time    timestamptz not null,                          -- 수업 종료 시각
    min_capacity int not null default 1,                       -- 최소 인원 (미달 시 폐강 대상)
    capacity    int not null default 1,                        -- 최대 정원
    allow_goods boolean not null default true,               -- 예약 시 회원이 보유 상품(대여 등)을 함께 사용 가능한지

    -- 마감/자동처리 시간 (분 단위. 수업 시작 기준 몇 분 전까지 허용할지)
    -- 예: 60 = 시작 1시간 전까지 / 0 = 시작 직전(당일)까지 가능
    booking_deadline_min   int not null default 0,             -- 예약 마감
    cancel_deadline_min    int not null default 0,             -- 취소 마감
    autocancel_deadline_min int,                                -- 폐강 확정 시간 (최소인원 미달 시)
    waitlist_deadline_min  int,                                 -- 대기 자동승격 마감

    status      text not null default 'open'
                check (status in ('open', 'closed', 'cancelled')),  -- cancelled = 폐강
    created_at  timestamptz not null default now()
);

comment on table classes is '센터에서 개설하는 수업 스케줄. 정원까지 예약 가능, 마감시간·폐강 규칙 포함';
comment on column classes.class_type_id is '수업구분(class_types 참조). 수강권 종류에 따라 예약 가능한 수업이 달라짐';
comment on column classes.place is '장소. 같은 시간대 한 장소에 여러 수업 중복 허용';


-- ------------------------------------------------------------
-- 3-1. 수업 담당 강사 (복수 배정 가능)
--      한 수업에 강연우T + 손지윤T 처럼 여러 강사 배정
-- ------------------------------------------------------------
create table class_trainers (
    id          uuid primary key default gen_random_uuid(),
    class_id    uuid not null references classes(id) on delete cascade,
    account_id  uuid not null references accounts(id),         -- 강사 계정
    unique (class_id, account_id)
);

comment on table class_trainers is '수업별 담당 강사(복수 가능)';


-- ------------------------------------------------------------
-- 4. 수강권 테이블 (회원이 구매한 이용권 - 잔여횟수/기간 관리)
-- ------------------------------------------------------------
create table memberships (
    id                uuid primary key default gen_random_uuid(),
    profile_id        uuid not null references profiles(id),   -- 이 수강권의 주인(프로필)
    center_id         uuid not null references centers(id),    -- 어느 센터 수강권인지
    product_id        uuid,                                    -- products(id). FK는 파일 끝에서 추가. 예약조건 조회용
    product_name      text not null,                           -- 상품명 (예: "10회 이용권")
    -- 수강권 종류: count(횟수권) / period(기간권, 무제한)
    pass_type         text not null default 'count'
                      check (pass_type in ('count', 'period')),
    total_count       int,                                     -- 총 구매 횟수 (기간권이면 NULL)
    remaining_count   int,                                     -- 현재 남은 횟수 (기간권이면 NULL)
    -- 안전장치: 어떤 코드 경로로도 잔여횟수가 음수가 되지 않게 DB에서 차단
    constraint memberships_remaining_not_negative
        check (remaining_count is null or remaining_count >= 0),
    starts_at         date not null default current_date,      -- 시작일
    expires_at        date not null,                           -- 만료일 (이 날짜 지나면 사용 불가)
    -- 기간권 자동연장(CMS 자동결제): 만료 시 자동 결제되어 연장
    auto_renew        boolean not null default false,
    -- 수강권 정지 (일시정지 기간만큼 만료일 연장)
    paused_from       date,
    paused_until      date,
    -- 다중예약 수강권 여부: 같은 시간대에 여러 수업을 동시 예약할 수 있는지
    allow_multi_booking boolean not null default false,
    -- 수강권 상태 (회원목록/엑셀의 "상태" 컬럼)
    status            text not null default 'active'
                      check (status in ('active', 'expired', 'paused', 'refunded', 'transferred')),
    trainer_account_id uuid references accounts(id),           -- 담당 강사
    issued_at         date not null default current_date,      -- 발급일
    updated_at        timestamptz not null default now(),      -- 최종수정일
    created_at        timestamptz not null default now()
);

comment on column memberships.allow_multi_booking is '같은 시간대 복수 수업 동시 예약 허용 여부';
comment on column memberships.status is 'active(사용중)/expired(만료)/paused(정지)/refunded(환불)/transferred(양도)';

comment on table memberships is '회원의 수강권. 횟수권/기간권 구분, 기간권은 자동연장 옵션 가능';
comment on column memberships.auto_renew is '기간권 만료 시 자동결제로 연장 (CMS)';


-- ------------------------------------------------------------
-- 4-1. 수강권 예약가능 조건 테이블 (피드백 반영: 핵심 구조!)
--      "안무반 수강권은 월요일 7시, 수요일 9시 수업만 예약 가능"
--      처럼 수강권 하나에 여러 요일/시간 조건을 붙일 수 있음.
--      조건이 하나도 없으면 = 모든 수업 예약 가능
-- ------------------------------------------------------------
-- 수업별 예약 가능 수강권 (수업 1 : 수강권 N)
--   연결이 하나도 없으면 = 모든 수강권으로 예약 가능(제한 없음)
--   연결이 있으면 = 그 수강권들로만 예약 가능
create table class_allowed_products (
    id          uuid primary key default gen_random_uuid(),
    class_id    uuid not null references classes(id) on delete cascade,
    product_id  uuid not null,   -- products(id). FK는 파일 끝(products 정의 이후)
    created_at  timestamptz not null default now(),
    unique (class_id, product_id)
);

create table membership_schedule_rules (
    id              uuid primary key default gen_random_uuid(),
    product_id      uuid not null,                               -- products(id). FK는 파일 끝에서 추가(정의 순서)
    day_of_week     int check (day_of_week between 0 and 6),    -- 요일 (0=일요일 ~ 6=토요일), NULL이면 모든 요일
    start_time      time,                                        -- 예약 가능한 수업 시작시간 (예: 19:00), NULL이면 모든 시간
    class_title     text,                                        -- 특정 수업명으로 제한할 때 (예: "안무반"), NULL이면 모든 수업
    created_at      timestamptz not null default now()
);

comment on table membership_schedule_rules is '수강권별 예약가능 요일/시간/수업 조건. 수강권을 요일별로 쪼개지 않아도 되게 함 (센터 피드백 반영)';
-- 예시: "안무반 수강권"에 (월요일, 19:00, 안무반) + (수요일, 21:00, 안무반) 두 줄을 넣으면
--       그 수강권으로는 해당 시간 안무반만 예약 가능


-- ------------------------------------------------------------
-- 5. 예약 테이블 (회원이 특정 수업에 신청한 기록)
-- ------------------------------------------------------------
create table reservations (
    id              uuid primary key default gen_random_uuid(),
    class_id        uuid not null references classes(id),       -- 어떤 수업을 예약했는지
    profile_id      uuid not null references profiles(id),      -- 누가 예약했는지(프로필)
    membership_id   uuid references memberships(id),            -- 어느 수강권으로 예약했는지 (횟수 차감용)
    status          text not null default 'confirmed'           -- 예약 상태
                    check (status in (
                        'confirmed',   -- 예약 확정
                        'waitlisted',  -- 대기중 (정원 초과 시)
                        'cancelled',   -- 취소됨
                        'attended',    -- 출석 완료
                        'no_show'      -- 노쇼(무단 불참)
                    )),
    waitlist_order  int,                                        -- 대기 순번 (waitlisted 상태일 때만 사용)
    member_memo     text,                                       -- 회원 개인 메모 (본인만, 선택)
    created_at      timestamptz not null default now()
);

comment on table reservations is '예약/취소/대기 내역. status 컬럼으로 현재 상태 구분 (하이파이브+스튜디오메이트 참고 기능)';

-- 같은 회원이 같은 수업을 중복 예약하지 못하도록 방지
create unique index unique_active_reservation
    on reservations (class_id, profile_id)
    where status in ('confirmed', 'waitlisted');


-- ------------------------------------------------------------
-- 6. 결제 테이블 (수강권 결제 내역 - 3차 확장 기능)
-- ------------------------------------------------------------
create table payments (
    id                  uuid primary key default gen_random_uuid(),
    profile_id          uuid not null references profiles(id),
    center_id           uuid not null references centers(id),   -- 매출 집계 단위
    membership_id       uuid references memberships(id),
    product_pass_id     uuid,                                    -- 상품(대여권 등) 결제인 경우. FK는 product_passes 정의 후 아래에서 추가

    -- 매출 구분 (스튜디오메이트 참고)
    sale_type           text not null default 'new'
                        check (sale_type in (
                            'new',          -- 신규결제
                            'renew',        -- 재결제(재등록)
                            'trial',        -- 체험
                            'upgrade',      -- 업그레이드
                            'refund',       -- 환불
                            'unpaid_pay',   -- 미수금 결제
                            'transfer_fee'  -- 양도/환불 수수료
                        )),
    -- 매출 종류: 수강권 매출 / 수업 매출 / 기타 매출
    revenue_category    text not null default 'membership'
                        check (revenue_category in ('membership', 'class', 'etc')),

    -- 분할 결제: 한 건을 여러 수단으로 나눠 받을 수 있음 (카드 5만 + 현금 3만 등)
    card_amount         int not null default 0,                  -- 카드결제금
    cash_amount         int not null default 0,                  -- 현금결제금
    transfer_amount     int not null default 0,                  -- 계좌이체금
    point_amount        int not null default 0,                  -- 포인트 사용금액
    total_amount        int not null default 0,                  -- 결제금액 합계 (환불이면 음수)
    unpaid_amount       int not null default 0,                  -- 미수금
    penalty_amount      int not null default 0,                  -- 위약금 (환불 시)
    per_session_amount  int,                                     -- 회당 금액 (총액/전체횟수)
    total_sessions      int,                                     -- 전체 횟수

    trainer_account_id  uuid references accounts(id),            -- 담당 강사 (매출 귀속)
    paid_at             timestamptz not null default now(),      -- 결제일
    memo                text,

    -- PG 연동용 (온라인 결제인 경우)
    pg_transaction_id   text,
    status              text not null default 'paid'
                        check (status in ('pending', 'paid', 'refunded', 'failed')),
    virtual_account_bank    text,
    virtual_account_number  text,
    virtual_account_due_at  timestamptz,
    created_at          timestamptz not null default now()
);

comment on table payments is '매출 원장. 분할결제(카드/현금/계좌이체/포인트) 지원, 미수금·위약금 포함';
comment on column payments.sale_type is '신규/재결제/체험/업그레이드/환불/미수금결제/양도·환불수수료';

create index idx_payments_center_date on payments (center_id, paid_at);


-- ------------------------------------------------------------
-- 11-1. 지출 (매출 화면의 "지출" 탭)
-- ------------------------------------------------------------
create table expenses (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    category    text not null,                                  -- 예: "임대료", "강사료", "비품"
    amount      int not null,
    spent_at    date not null default current_date,
    memo        text,
    created_at  timestamptz not null default now()
);

comment on table expenses is '센터 지출 내역. 매출 리포트에서 수입-지출 집계에 사용';


-- ------------------------------------------------------------
-- 11-2. 포인트 (잔여 포인트 / 적립·사용 내역)
-- ------------------------------------------------------------
create table point_transactions (
    id          uuid primary key default gen_random_uuid(),
    profile_id  uuid not null references profiles(id),
    center_id   uuid not null references centers(id),           -- 포인트는 센터별로 관리
    amount      int not null,                                    -- 적립 +, 사용 -
    reason      text,                                            -- 예: "재등록 적립", "수강권 결제 사용"
    payment_id  uuid references payments(id),                    -- 결제에 사용된 경우 연결
    created_at  timestamptz not null default now()
);

comment on table point_transactions is '포인트 적립/사용 내역. 잔여 포인트 = 합계';


-- ------------------------------------------------------------
-- 7. 채팅 테이블 (회원-트레이너/센터 간 앱 내 대화 - 2차 확장 기능)
-- ------------------------------------------------------------
create table chat_messages (
    id            uuid primary key default gen_random_uuid(),
    sender_account_id   uuid not null references accounts(id),  -- 보낸 계정
    receiver_account_id uuid not null references accounts(id),  -- 받는 계정
    content       text not null,                                -- 메시지 내용
    is_read       boolean not null default false,               -- 읽음 여부
    created_at    timestamptz not null default now()
);

comment on table chat_messages is '개인번호 노출 없이 회원-트레이너/센터 간 소통 (하이파이브 참고 기능)';


-- ------------------------------------------------------------
-- 8. 매출 조회를 쉽게 하기 위한 뷰(view) - 실제 테이블이 아니라 조회 전용 화면
-- ------------------------------------------------------------
create view revenue_summary as
select
    (p.paid_at at time zone 'Asia/Seoul')::date as 결제일,
    p.center_id                                 as 센터_id,
    p.revenue_category                          as 매출종류,   -- membership/class/etc
    count(*)                                    as 결제건수,
    sum(p.total_amount)                         as 총매출,
    sum(p.card_amount)                          as 카드,
    sum(p.cash_amount)                          as 현금,
    sum(p.transfer_amount)                      as 계좌이체,
    sum(p.point_amount)                         as 포인트,
    sum(p.unpaid_amount)                        as 미수금
from payments p
where p.status = 'paid'
group by (p.paid_at at time zone 'Asia/Seoul')::date, p.center_id, p.revenue_category;

comment on view revenue_summary is '일자/센터/매출종류별 매출 요약 (한국시간 기준). 수단별 금액·미수금 포함';


-- ------------------------------------------------------------
-- 9. 수강권 양도 이력 테이블 (회원 간 수강권 양도 - 2차 확장 기능)
-- ------------------------------------------------------------
create table membership_transfers (
    id                uuid primary key default gen_random_uuid(),
    membership_id     uuid not null references memberships(id),    -- 양도된 수강권
    from_profile_id   uuid not null references profiles(id),        -- 양도한 프로필
    to_profile_id     uuid not null references profiles(id),        -- 양도받은 프로필
    remaining_count_at_transfer  int not null,                     -- 양도 시점의 잔여횟수 (기록용)
    created_at        timestamptz not null default now()
);

comment on table membership_transfers is '프로필 간 수강권 양도 이력. memberships.profile_id를 변경하면서 기록';


-- ------------------------------------------------------------
-- 10. 팝업/공지 알림 테이블 (앱 실행 시 즉시 노출되는 공지 - 2차 확장 기능)
-- ------------------------------------------------------------
create table popup_notices (
    id            uuid primary key default gen_random_uuid(),
    center_id     uuid references centers(id),                    -- 특정 센터 대상 (전체 공지는 NULL)
    title         text not null,                                   -- 팝업 제목
    content       text,                                             -- 팝업 내용
    image_url     text,                                             -- 첨부 이미지
    starts_at     timestamptz not null default now(),               -- 노출 시작 시각
    ends_at       timestamptz,                                      -- 노출 종료 시각
    created_at    timestamptz not null default now()
);

comment on table popup_notices is '앱 접속 시 즉시 노출되는 팝업 공지 (하이파이브의 무료 푸시알림 참고 기능 확장)';


-- ------------------------------------------------------------
-- 11. 대회/이벤트 정보 테이블 (종목별 대회정보 조회 - 3차 확장 기능)
-- ------------------------------------------------------------
create table competitions (
    id            uuid primary key default gen_random_uuid(),
    title         text not null,                                   -- 대회명
    category      text not null,                                    -- 종목 (예: "크로스핏", "필라테스")
    region        text,                                              -- 지역
    event_date    date not null,                                    -- 대회 일자
    description   text,                                              -- 상세 설명
    source_url    text,                                              -- 원문 링크(외부 등록 대회일 경우)
    created_at    timestamptz not null default now()
);

comment on table competitions is '종목별로 필터링해 조회하는 대회/이벤트 정보';


-- ------------------------------------------------------------
-- 12. 커뮤니티 게시글/댓글 테이블 (3차 확장 기능)
-- ------------------------------------------------------------
create table community_posts (
    id            uuid primary key default gen_random_uuid(),
    author_account_id uuid not null references accounts(id),         -- 작성 계정
    center_id     uuid references centers(id),                      -- 특정 센터 게시판 (전체 공개면 NULL)
    title         text not null,
    content       text not null,
    created_at    timestamptz not null default now()
);

create table community_comments (
    id            uuid primary key default gen_random_uuid(),
    post_id       uuid not null references community_posts(id),
    author_account_id uuid not null references accounts(id),
    content       text not null,
    created_at    timestamptz not null default now()
);

comment on table community_posts is '회원 커뮤니티 게시판 (앱 컨셉에 맞는 커뮤니티 기능)';
comment on table community_comments is '커뮤니티 게시글에 달리는 댓글';


-- ------------------------------------------------------------
-- 13. 센터-회원 상호 평점 테이블 (당근마켓 매너온도 방식 참고 - 3차 확장 기능)
-- ------------------------------------------------------------
create table reviews (
    id              uuid primary key default gen_random_uuid(),
    reviewer_account_id uuid not null references accounts(id),       -- 평가한 계정
    target_account_id uuid references accounts(id),                  -- 평가 대상이 사람(강사 등)인 경우
    target_center_id uuid references centers(id),                   -- 평가 대상이 센터인 경우
    rating          int not null check (rating between 1 and 5),    -- 별점 1~5
    content         text,                                            -- 리뷰 내용
    created_at      timestamptz not null default now(),

    -- 사람 또는 센터 중 하나만 평가 대상으로 지정되도록 체크
    constraint review_target_check check (
        (target_account_id is not null and target_center_id is null)
        or (target_account_id is null and target_center_id is not null)
    )
);

comment on table reviews is '회원↔센터, 회원↔강사 간 상호 평점/리뷰 (당근온도 참고 기능)';


-- ------------------------------------------------------------
-- 13-1. 진도표 카테고리 테이블 (피드백 반영: 새 기능!)
--       센터마다 자유롭게 만드는 무한 중첩 카테고리.
--       예: 피겨 → 점프 → 왈츠점프/싱글살코/싱글토룹...
--       parent_id로 자기 자신을 참조해서 깊이 제한 없이 중첩 가능
-- ------------------------------------------------------------
create table progress_categories (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),             -- 어느 센터의 카테고리인지 (센터마다 다르게 구성)
    parent_id   uuid references progress_categories(id),          -- 상위 카테고리 (최상위면 NULL)
    name        text not null,                                     -- 카테고리/기술 이름 (예: "점프", "왈츠점프")
    sort_order  int not null default 0,                            -- 표시 순서
    created_at  timestamptz not null default now()
);

comment on table progress_categories is '진도표용 무한 중첩 카테고리. 센터가 직접 생성/수정 (개수 제한 없음)';


-- ------------------------------------------------------------
-- 13-2. 진도 기록 테이블
--       레슨 끝나고 코치가 "오늘 가르친 기술"을 클릭하면 한 줄씩 기록됨.
--       텍스트로 안 쓰고 클릭만으로 날짜별 진도 메모가 자동 완성되는 구조
-- ------------------------------------------------------------
create table progress_records (
    id            uuid primary key default gen_random_uuid(),
    profile_id    uuid not null references profiles(id),           -- 어느 프로필의 진도인지
    category_id   uuid not null references progress_categories(id),-- 배운 기술 (최하위 카테고리)
    coach_account_id uuid references accounts(id),                  -- 기록한 코치(계정)
    lesson_date   date not null default current_date,               -- 수업 날짜
    note          text,                                              -- 보조 메모 (예: "왈츠점프 약간 애매함")
    created_at    timestamptz not null default now()
);

comment on table progress_records is '회원별 날짜별 진도 기록. 코치가 클릭으로 기록 (예: 7/12 왈츠점프, 스파이럴 배움)';


-- ------------------------------------------------------------
-- 13-3. 회원별 센터 색상 설정 테이블 (피드백 반영)
--       통합 캘린더에서 센터마다 점 색깔로 구분하는데,
--       센터들이 정한 기본색이 비슷하면 회원이 본인 화면에서 직접 변경 가능
-- ------------------------------------------------------------
create table member_center_colors (
    id          uuid primary key default gen_random_uuid(),
    account_id  uuid not null references accounts(id),             -- 계정
    center_id   uuid not null references centers(id),              -- 센터
    color       text not null,                                      -- 색상 (예: "#E8543A")
    unique (account_id, center_id)                                  -- 계정-센터 조합당 하나만
);

comment on table member_center_colors is '통합 캘린더에서 회원이 직접 설정하는 센터별 표시 색상';


-- ------------------------------------------------------------
-- 13-4. 센터 휴무일 테이블 (피드백 반영)
--       휴무일은 달력에 빨간색으로 표시
-- ------------------------------------------------------------
create table center_holidays (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    holiday_date date not null,                                     -- 휴무 날짜
    reason      text,                                                -- 사유 (예: "정기휴무", "빙질정비")
    unique (center_id, holiday_date)
);

comment on table center_holidays is '센터 휴무일. 회원 달력에 빨간색으로 표시됨';


-- ------------------------------------------------------------
-- 13-5. 회원 등급 (센터가 정의: VIP, 신규, 기존 등)
-- ------------------------------------------------------------
create table member_grades (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    name        text not null,                                  -- 예: "VIP", "기존회원", "신규"
    color       text,                                            -- 배지 색상
    sort_order  int not null default 0,
    unique (center_id, name)
);

comment on table member_grades is '센터가 정의하는 회원 등급. 회원목록 필터/배지에 사용';


-- ------------------------------------------------------------
-- 13-6. 센터-회원 연결 (센터에 등록된 회원 명단)
--       센터가 직접 등록한 회원은 앱 계정이 없을 수도 있음(앱연결 여부)
-- ------------------------------------------------------------
create table center_members (
    id              uuid primary key default gen_random_uuid(),
    center_id       uuid not null references centers(id),
    profile_id      uuid not null references profiles(id),
    grade_id        uuid references member_grades(id),           -- 회원 등급
    registered_at   date not null default current_date,          -- 등록일
    last_attended_at date,                                       -- 최근 출석일
    -- 앱연결: 센터가 수기로 만든 회원은 앱 계정과 연결 전일 수 있음
    app_linked      boolean not null default false,              -- 앱연결 여부
    app_email       text,                                        -- 앱연결 이메일
    memo            text,                                        -- 관리자 메모 (회원에겐 안 보임)
    status          text not null default 'active'
                    check (status in ('active', 'expired', 'dormant')),  -- 만료회원/휴면회원 필터용
    unique (center_id, profile_id)
);

comment on table center_members is '센터에 등록된 회원 명단. 등급·출석·앱연결 여부·메모 관리';


-- ------------------------------------------------------------
-- 13-7. 상담고객 (아직 등록 전 잠재고객)
-- ------------------------------------------------------------
create table leads (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    name        text not null,
    phone       text,
    channel     text,                                            -- 유입경로 (예: "인스타", "지인소개")
    status      text not null default 'new'
                check (status in ('new', 'contacted', 'converted', 'dropped')),
    memo        text,
    created_at  timestamptz not null default now()
);

comment on table leads is '상담고객(등록 전 잠재고객). 등록 전환 시 center_members로 이동';


-- ------------------------------------------------------------
-- 13-8. 변경이력 (수강권 정보 변경 추적)
-- ------------------------------------------------------------
create table change_logs (
    id              uuid primary key default gen_random_uuid(),
    center_id       uuid not null references centers(id),
    target_table    text not null,                               -- 예: 'memberships'
    target_id       uuid not null,                               -- 변경된 행 id
    action          text not null,                               -- 'create'/'update'/'delete'
    changed_fields  jsonb,                                       -- {"remaining_count": [5, 4]}
    actor_account_id uuid references accounts(id),               -- 변경한 사람
    created_at      timestamptz not null default now()
);

comment on table change_logs is '수강권 등 주요 정보 변경이력. 누가 언제 무엇을 바꿨는지 추적';


-- ------------------------------------------------------------
-- 13-9. 스태프 급여 설정 (권한: facility.salary.*)
--       근무 형태(정규직/파트타임/대강)에 따라 급여 설정
-- ------------------------------------------------------------
create table staff_salaries (
    id              uuid primary key default gen_random_uuid(),
    center_id       uuid not null references centers(id),
    account_id      uuid not null references accounts(id),       -- 대상 스태프
    employment_type text not null default 'fulltime'
                    check (employment_type in ('fulltime', 'parttime', 'substitute')),
                    -- fulltime(정규직) / parttime(파트타임) / substitute(대강)
    base_salary     int,                                          -- 기본급 (정규직)
    per_class_pay   int,                                          -- 수업당 급여 (파트타임/대강)
    commission_rate numeric(5,2),                                 -- 매출 인센티브 비율(%)
    memo            text,
    updated_at      timestamptz not null default now(),
    unique (center_id, account_id)
);

comment on table staff_salaries is '스태프 급여 설정. 급여 정보는 권한(본인/타인)에 따라 조회·수정 제한';


-- ------------------------------------------------------------
-- 13-10. 기타 일정 (수업이 아닌 스태프 개인 일정)
--        권한: schedule.own.etc.*
-- ------------------------------------------------------------
create table staff_schedules (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    account_id  uuid not null references accounts(id),           -- 일정 주인
    title       text not null,                                   -- 예: "휴가", "외부 미팅"
    start_time  timestamptz not null,
    end_time    timestamptz not null,
    memo        text,
    created_at  timestamptz not null default now()
);

comment on table staff_schedules is '수업 외 기타 일정(휴가·미팅 등). 일정 화면에 함께 표시';


-- ------------------------------------------------------------
-- 13-11. 일정 메모 (수업 상세페이지 메모)
--        권한: schedule.memo.*  (본인 것만 수정/삭제, 오너는 전체)
-- ------------------------------------------------------------
create table schedule_memos (
    id              uuid primary key default gen_random_uuid(),
    class_id        uuid references classes(id) on delete cascade,
    staff_schedule_id uuid references staff_schedules(id) on delete cascade,
    author_account_id uuid not null references accounts(id),
    content         text not null,
    created_at      timestamptz not null default now(),
    -- 수업 메모이거나 기타일정 메모이거나 (둘 중 하나)
    check ((class_id is not null and staff_schedule_id is null)
        or (class_id is null and staff_schedule_id is not null))
);

comment on table schedule_memos is '일정 상세페이지 메모. 본인 작성분만 수정/삭제 (오너는 전체)';


-- ------------------------------------------------------------
-- 13-12. 전자계약서 (권한: contract.*)
-- ------------------------------------------------------------
create table contract_templates (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    name        text not null,                                  -- 템플릿 이름
    content     text not null,                                  -- 계약서 본문 (변수 사용 가능)
    is_active   boolean not null default true,
    description text,                                           -- 상품 상세 설명 (이름 클릭 시 표시)
    auto_book_days  int[],                                      -- 요일반 수강권: 자동예약 대상 요일 (0=일~6=토). 예: 화요일반 → {2}
    sizes       text[],                                         -- 대여상품 사이즈 목록 (예: {"230","240","250"})
    created_at  timestamptz not null default now()
);

create table terms (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    title       text not null,                                  -- 예: "환불 규정"
    content     text not null,
    is_required boolean not null default true,                  -- 필수 동의 여부
    sort_order  int not null default 0
);

comment on table terms is '약관 (권한: contract.terms.manage)';

create table contracts (
    id           uuid primary key default gen_random_uuid(),
    center_id    uuid not null references centers(id),
    profile_id   uuid not null references profiles(id),
    template_id  uuid references contract_templates(id),
    membership_id uuid references memberships(id),              -- 어떤 수강권 등록 건인지
    content      text not null,                                 -- 서명 시점 스냅샷
    signature_url text,                                         -- 서명 이미지 (Storage)
    signed_at    timestamptz,
    status       text not null default 'pending'
                 check (status in ('pending', 'signed', 'cancelled')),
    created_at   timestamptz not null default now()
);

comment on table contracts is '회원이 서명한 전자계약서. 서명 시점 내용을 스냅샷으로 보관';


-- ------------------------------------------------------------
-- 13-5. 센터별 회원정보 항목 (센터가 필요한 정보를 직접 지정)
--       회원가입 때는 필수사항(이름·전화)만 받고,
--       각 센터에 수강권 등록/센터 등록할 때 그 센터가 지정한 항목을 입력받음
--       예: 피겨 센터는 신발사이즈 필수, 발레 센터는 옷사이즈 필수
-- ------------------------------------------------------------
create table center_member_fields (
    id                uuid primary key default gen_random_uuid(),
    center_id         uuid not null references centers(id),
    field_key         text not null,                            -- 'birth_date','address','blood_type','shoe_size','cloth_size' 등
    label             text not null,                            -- 화면에 보일 이름 (예: "신발 사이즈")
    field_type        text not null default 'text'
                      check (field_type in ('text', 'number', 'date', 'select')),
    options           text[],                                   -- select인 경우 선택지
    is_required       boolean not null default false,           -- 이 센터 등록 시 필수 입력인지
    show_in_member_list boolean not null default false,         -- 관리자 회원목록에 노출할지 (회원용에는 안 보임)
    sort_order        int not null default 0,
    unique (center_id, field_key)
);

comment on table center_member_fields is '센터가 직접 지정하는 회원정보 항목. 필수 여부·목록 노출 여부 설정';

-- 프로필이 각 센터에 입력한 항목 값
create table profile_center_fields (
    id          uuid primary key default gen_random_uuid(),
    profile_id  uuid not null references profiles(id) on delete cascade,
    center_id   uuid not null references centers(id),
    field_key   text not null,
    value       text,
    unique (profile_id, center_id, field_key)
);

comment on table profile_center_fields is '회원이 각 센터에 입력한 추가정보 값 (신발사이즈 등). 관리자만 조회';


-- ------------------------------------------------------------
-- 13-6. 상품 (수강권과 별개로 파는 것)
--       예: 피겨 수강권과 별도로 "피겨화 대여권"
--       횟수권이면 수강권과 연동해서 예약 시 동시 차감 가능
-- ------------------------------------------------------------
create table products (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    name        text not null,                                  -- 예: "피겨화 대여권"
    price       int not null default 0,
    -- 상품 종류: pass(수강권-수업예약용) / goods(대여·물품 등)
    product_kind text not null default 'pass'
                check (product_kind in ('pass', 'goods')),
    -- 횟수 제한 없음(무제한) 여부 (goods에서 무제한 대여권 등에 사용)
    unlimited   boolean not null default false,
    pass_type   text not null default 'count'
                check (pass_type in ('count', 'period')),
    total_count int,                                            -- 횟수권이면 기본 횟수
    -- 판매 정지 / 재개 (권한: pass.sale_toggle)
    is_on_sale  boolean not null default true,                  -- false면 신규 판매 중지
    is_active   boolean not null default true,
    created_at  timestamptz not null default now()
);

comment on table products is '수강권과 별개로 판매하는 상품 (대여권 등)';

-- 회원이 보유한 상품권
create table product_passes (
    id                  uuid primary key default gen_random_uuid(),
    profile_id          uuid not null references profiles(id),
    product_id          uuid not null references products(id),
    remaining_count     int,                                    -- 남은 횟수
    expires_at          date,
    -- 수강권과 연동: 이 수강권으로 예약할 때 상품권도 같이 차감
    linked_membership_id uuid references memberships(id),
    created_at          timestamptz not null default now()
);

comment on table product_passes is '회원이 구매한 상품권. linked_membership_id 있으면 예약 시 수강권과 동시 차감';

-- payments.product_pass_id 외래키 (product_passes 정의 이후에 추가)
alter table payments
    add constraint payments_product_pass_fk
    foreign key (product_pass_id) references product_passes(id);


-- ------------------------------------------------------------
-- 13-7. 스케줄 템플릿 (매달 새로 등록 + 저장해둔 스케줄 불러오기)
--       요일별/날짜별로 복사해서 한 달치를 빠르게 생성
-- ------------------------------------------------------------
create table schedule_templates (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    name        text not null,                                  -- 예: "평일 정규 스케줄"
    -- 요일별 수업 구성을 JSON으로 저장
    -- 예: [{"day":1,"start":"19:00","end":"20:20","title":"정규반","capacity":10,"trainers":[...]}]
    template    jsonb not null,
    created_at  timestamptz not null default now()
);

comment on table schedule_templates is '저장해둔 스케줄. 매달 불러와서 한 번에 수업 생성';


-- ------------------------------------------------------------
-- 13-8. 자동알림 규칙 (카톡/문자, 건당 수수료 발생)
--       수강권 만료 임박·횟수 소진·정지 만료 시 자동 발송
-- ------------------------------------------------------------
create table notification_rules (
    id            uuid primary key default gen_random_uuid(),
    center_id     uuid not null references centers(id),
    trigger_type  text not null
                  check (trigger_type in (
                      'membership_expiring',   -- 수강권 기간 만료 (N일 전)
                      'count_low',             -- 잔여횟수 만료 (N회 남았을 때)
                      'pause_ending',          -- 정지기간 만료 (N일 전)
                      'expired_rebuy',         -- 만료 회원 재등록 권유
                      'class_reminder',        -- 수업 시작 전 알림
                      'waitlist_promoted',     -- 대기→예약 전환 (실시간 발송, 시점 설정 불가)
                      'class_cancelled',       -- 폐강 알림 (폐강시간에 맞춰 발송)
                      'birthday'               -- 생일 축하 (오후 3시 고정)
                  )),
    -- 발송 시점: 기간형은 days_before, 횟수형(count_low)은 threshold_count 사용
    days_before     int,                                        -- 예: 만료 3일 전
    threshold_count int,                                        -- 예: 잔여 1회일 때
    minutes_before  int,                                        -- 수업 시작 N분 전 (class_reminder)

    -- 발송 채널 (동시 선택 가능)
    send_push     boolean not null default true,
    send_sms      boolean not null default false,

    -- 메시지 템플릿. 변수 사용: [[회원명]], [[수강권명]], [[수강권 잔여일]], [[수강권 잔여횟수]] 등
    message_template text,

    is_active     boolean not null default true,
    created_at    timestamptz not null default now(),
    unique (center_id, trigger_type)
);

comment on table notification_rules is '자동 알림 규칙. Push/문자 동시 발송 가능, 템플릿에 [[변수]] 사용';
comment on column notification_rules.trigger_type is 'waitlist_promoted는 실시간·birthday는 15시 고정(시점 설정 불가)';


-- ------------------------------------------------------------
-- 메시지 발송 (문자/앱푸시). 예약 발송·취소 지원
--   권한: message.sms.*, message.push.*
--   SMS 건당 12P/90byte, LMS 건당 37P/2000byte (포인트 차감)
-- ------------------------------------------------------------
create table messages (
    id              uuid primary key default gen_random_uuid(),
    center_id       uuid not null references centers(id),
    channel         text not null check (channel in ('sms', 'lms', 'push')),
    title           text,                                       -- 푸시 제목
    content         text not null,
    -- 수신 대상 (프로필 목록). 대량 발송이라 배열로 보관
    target_profile_ids uuid[] not null default '{}',
    scheduled_at    timestamptz,                                -- 예약 발송 시각 (NULL이면 즉시)
    sent_at         timestamptz,
    status          text not null default 'draft'
                    check (status in ('draft','scheduled','sent','cancelled','failed')),
    byte_size       int,                                        -- 예상 바이트 (SMS 90 / LMS 2000 제한)
    point_cost      int,                                        -- 차감 포인트
    sender_account_id uuid references accounts(id),
    created_at      timestamptz not null default now()
);

comment on table messages is '문자/앱푸시 발송 이력. 예약발송(scheduled)은 취소 가능';

comment on table notification_rules is '센터별 자동알림 규칙. 재등록 유도용';

-- 발송 기록 (건당 수수료 정산용)
create table notification_logs (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id),
    profile_id  uuid references profiles(id),
    rule_id     uuid references notification_rules(id),
    channel     text not null,
    cost        int not null default 0,                         -- 건당 수수료(원)
    status      text not null default 'sent'
                check (status in ('sent', 'failed')),
    sent_at     timestamptz not null default now()
);

comment on table notification_logs is '알림 발송 기록. 건당 수수료 정산 근거';


-- ------------------------------------------------------------
-- 13-9. 센터 상담 채널 (1:1 바로상담)
--       센터가 지정해둔 메신저로 바로 연결
-- ------------------------------------------------------------
create table center_contacts (
    id            uuid primary key default gen_random_uuid(),
    center_id     uuid not null references centers(id),
    channel_type  text not null
                  check (channel_type in ('kakao_channel', 'kakao_personal', 'sms', 'instagram', 'phone')),
    value         text not null,                                -- 채널 URL 또는 번호
    label         text,                                         -- 표시 이름
    sort_order    int not null default 0
);

comment on table center_contacts is '센터가 지정한 1:1 상담 채널. 회원이 누르면 해당 메신저로 연결';


-- ------------------------------------------------------------
-- 13-10. 센터 생성 시 기본 역할 3개 자동 생성
--        스튜디오 오너 / 매니저 / 강사
--        (오너는 모든 권한 보유, 나머지는 오너가 권한 부여)
-- ------------------------------------------------------------
create or replace function create_default_center_roles()
returns trigger
language plpgsql
as $$
begin
    insert into center_roles (center_id, name, role_key, is_system, is_owner, sort_order) values
        (new.id, '스튜디오 오너', 'owner',   true, true,  0),
        (new.id, '매니저',       'manager', true, false, 1),
        (new.id, '강사',         'trainer', true, false, 2);
    return new;
end;
$$;

create trigger trg_create_default_center_roles
    after insert on centers
    for each row execute function create_default_center_roles();


-- ------------------------------------------------------------
-- 14. 보안 설정: 내 데이터는 나만 볼 수 있게 (Row Level Security)
-- ------------------------------------------------------------
-- 이 설정이 없으면 다른 회원의 예약/수강권까지 API로 조회될 수 있어 위험합니다.

-- 헬퍼: 지금 로그인한 계정(account)의 id
create or replace function my_account_id()
returns uuid
language sql stable
security definer
set search_path = public
as $$
    -- security definer: 정책 안에서 이 함수를 호출해도 accounts RLS를 다시
    --   타지 않게 함 (그렇지 않으면 accounts 조회 정책 ↔ 이 함수 사이 무한 재귀)
    select id from accounts where auth_id = auth.uid();
$$;

-- 헬퍼: 지금 로그인한 계정이 소유한 프로필 id 목록
create or replace function my_profile_ids()
returns setof uuid
language sql stable
security definer
set search_path = public
as $$
    select id from profiles where account_id = my_account_id();
$$;


-- 헬퍼: 지금 로그인한 계정이 플랫폼 운영자인지
create or replace function is_platform_admin()
returns boolean
language sql stable
security definer
as $$
    select coalesce(
        (select is_platform_admin from accounts where auth_id = auth.uid()),
        false
    );
$$;

alter table accounts enable row level security;
alter table profiles enable row level security;
alter table manager_centers enable row level security;
alter table memberships enable row level security;
alter table reservations enable row level security;
alter table chat_messages enable row level security;
alter table community_posts enable row level security;
alter table reviews enable row level security;

-- 계정: 본인 계정 행만 조회/수정
-- 주의: for all 로 만들면 SELECT 에도 조건이 걸려서,
--   오너가 스태프/회원 계정을 조회하는 정책과 충돌합니다.
--   (같은 명령에 정책이 여럿이면 전부 통과해야 하므로 조회 불가)
--   → 쓰기는 본인만, 조회 정책은 reservation_functions.sql 에서 별도 정의합니다.
create policy "본인 계정 수정"
    on accounts for update
    using (auth_id = auth.uid())
    with check (auth_id = auth.uid());

create policy "본인 계정 삭제"
    on accounts for delete
    using (auth_id = auth.uid());

-- 조회: 기본은 본인만. (오너의 스태프/회원 조회는 reservation_functions.sql 에서 확장)
create policy "계정 조회"
    on accounts for select
    using (auth_id = auth.uid());

-- 프로필: 본인 계정이 소유한 프로필만 관리
-- 주의: for all 로 만들면 SELECT 에도 이 조건이 걸려서,
--   매니저가 자기 센터 회원의 프로필을 보는 정책(reservation_functions.sql)과
--   충돌합니다(두 정책 모두 통과해야 하므로 조회 불가).
--   → 쓰기(insert/update/delete)에만 본인 조건을 겁니다.
create policy "본인 프로필 생성"
    on profiles for insert
    with check (account_id = my_account_id());

create policy "본인 프로필 수정"
    on profiles for update
    using (account_id = my_account_id())
    with check (account_id = my_account_id());

create policy "본인 프로필 삭제"
    on profiles for delete
    using (account_id = my_account_id());

-- 매니저-센터: 본인 계정의 것만 관리
-- 주의: for all 은 SELECT 에도 걸려서 오너의 스태프 조회 정책과 충돌합니다.
--   → 쓰기만 본인 조건. 조회/초대 정책은 reservation_functions.sql 에서 정의.
create policy "본인 매니저센터 수정"
    on manager_centers for update
    using (account_id = my_account_id())
    with check (account_id = my_account_id());

create policy "본인 매니저센터 삭제"
    on manager_centers for delete
    using (account_id = my_account_id());

create policy "본인 매니저센터 조회"
    on manager_centers for select
    using (account_id = my_account_id());

-- 수강권: 내 프로필의 것만 조회
create policy "내 프로필 수강권 조회"
    on memberships for select
    using (profile_id in (select my_profile_ids()));

-- 예약: 내 프로필의 것만 조회
create policy "내 프로필 예약 조회"
    on reservations for select
    using (profile_id in (select my_profile_ids()));

-- 커뮤니티 게시글: 로그인 사용자 누구나 조회
create policy "로그인 사용자는 커뮤니티 게시글 조회 가능"
    on community_posts for select
    using (auth.role() = 'authenticated');

-- 리뷰: 로그인 사용자 누구나 조회
create policy "로그인 사용자는 리뷰 조회 가능"
    on reviews for select
    using (auth.role() = 'authenticated');

-- ============================================================
-- 구조 요약:
--   accounts (로그인) ─┬─ profiles (회원 역할 · 여러 프로필)
--                      └─ manager_centers (매니저/강사 역할 · 센터)
--   예약/수강권/진도 = profiles 에 연결
--   회원가입 시: accounts 1행 + 본인 profiles 1행 자동 생성
--   매니저 가입 시: accounts.is_manager=true + manager_centers 1행 + centers 1행
-- ============================================================


-- ------------------------------------------------------------
-- 개인별 권한 예외 테이블의 외래키 (모든 테이블 정의 이후에 추가)
-- ------------------------------------------------------------
alter table account_center_permissions
    add constraint acp_key_fk
    foreign key (permission_key) references permissions(key) on delete cascade;

alter table account_center_permissions
    add constraint acp_mc_fk
    foreign key (manager_center_id) references manager_centers(id) on delete cascade;


-- ------------------------------------------------------------
-- 수강권 예약조건: products 참조 FK (products 정의 이후에 추가)
-- ------------------------------------------------------------
alter table membership_schedule_rules
    add constraint msr_product_fk
    foreign key (product_id) references products(id) on delete cascade;

alter table memberships
    add constraint memberships_product_fk
    foreign key (product_id) references products(id);

-- 수업-수강권 연결: products 참조 FK (products 정의 이후)
alter table class_allowed_products
    add constraint cap_product_fk
    foreign key (product_id) references products(id) on delete cascade;


-- ============================================================
-- 플랫폼 종목 목록 (운영자가 관리)
-- ============================================================
create table if not exists service_categories (
    id          uuid primary key default gen_random_uuid(),
    label       text not null unique,                         -- 종목 이름 (예: "필라테스")
    emoji       text,                                         -- 아이콘 이모지
    sort_order  int not null default 0,                       -- 홈 표시 순서
    created_at  timestamptz not null default now()
);

-- ============================================================
-- 홈 배너 (운영자가 관리, 순서대로 회전)
-- ============================================================
create table if not exists home_banners (
    id          uuid primary key default gen_random_uuid(),
    title       text not null,                                -- 배너 큰 문구
    subtitle    text,                                         -- 작은 문구
    emoji       text,                                         -- 장식 이모지
    link_url    text,                                         -- 누르면 이동할 경로 (선택)
    is_active   boolean not null default true,                -- 노출 여부
    sort_order  int not null default 0,                       -- 회전 순서
    created_at  timestamptz not null default now()
);


-- ============================================================
-- 구매 신청 (온라인 결제 전 단계: 회원이 앱에서 구매 의사 → 매니저 확인)
-- ============================================================
create table if not exists purchase_requests (
    id           uuid primary key default gen_random_uuid(),
    center_id    uuid not null references centers(id) on delete cascade,
    profile_id   uuid not null references profiles(id) on delete cascade,
    product_id   uuid references products(id) on delete set null,
    product_name text not null,
    status       text not null default 'pending'
                 check (status in ('pending', 'done', 'cancelled')),  -- 처리 상태
    created_at   timestamptz not null default now()
);


-- ============================================================
-- 주문 (수강권/상품 구매 결제)
--   결제 수단은 나중에 연동. 지금은 pending으로 주문 생성 후
--   매니저가 확인/완료 처리 (또는 결제 연동 시 자동 완료)
-- ============================================================
create table if not exists orders (
    id            uuid primary key default gen_random_uuid(),
    center_id     uuid not null references centers(id) on delete cascade,
    profile_id    uuid not null references profiles(id) on delete cascade,
    product_id    uuid references products(id) on delete set null,
    product_name  text not null,
    amount        int not null default 0,                        -- 결제 금액
    pay_method    text,                                          -- 결제 수단 (나중에: card/kakao/toss 등)
    status        text not null default 'pending'
                  check (status in ('pending', 'paid', 'cancelled', 'done')),
    created_at    timestamptz not null default now(),
    paid_at       timestamptz
);


-- ============================================================
-- 룸(장소) - 센터가 사용하는 강습 공간
-- ============================================================
create table if not exists rooms (
    id          uuid primary key default gen_random_uuid(),
    center_id   uuid not null references centers(id) on delete cascade,
    name        text not null,                                -- 예: "A룸", "1번 스튜디오"
    memo        text,                                         -- 설명 (선택)
    address     text,                                         -- 룸 주소 (회원 길찾기용, 선택)
    latitude    double precision,                             -- 좌표 (선택)
    longitude   double precision,                             -- 좌표 (선택)
    sort_order  int not null default 0,
    created_at  timestamptz not null default now()
);
