-- ============================================================
-- admin_action_logs를 향후 범용 감사로그로 확장하기 위한 스키마 완화
--
-- 배경:
--   admin_action_logs는 지금까지 예약 관련 액션(직접배치/무료배치/취소) 전용으로 설계되어
--   reservation_id/class_id/member_profile_id/reservation_type/reservation_source가 전부
--   NOT NULL이었다. 향후 이 테이블을 공지/수업/수강권 CRUD 같은 "예약이 아닌" 관리자 액션의
--   감사로그로도 재사용하려면, 그 액션들엔 해당 없는 이 컬럼들을 nullable로 풀어야 한다.
--
--   기존 4종 액션(CREATE_ASSIGNMENT/CREATE_FREE/CANCEL_ASSIGNMENT/CANCEL_FREE)은 지금처럼
--   계속 이 컬럼들을 전부 채워서 기록한다 — 이 마이그레이션은 제약만 완화할 뿐, 기존 코드가
--   생성하는 로그의 내용이나 기존 행의 값은 전혀 바꾸지 않는다(데이터 손실 없음).
--
-- 적용 전제: add_admin_assignment.sql 적용 후 실행. 여러 번 실행해도 안전.
-- ============================================================

alter table admin_action_logs
    alter column reservation_id drop not null,
    alter column class_id drop not null,
    alter column member_profile_id drop not null,
    alter column reservation_type drop not null,
    alter column reservation_source drop not null;

comment on column admin_action_logs.reservation_id is
    '예약 관련 액션(CREATE_*/CANCEL_*)에서만 채워짐. 공지/수업/수강권 등 향후 비예약 액션에는 NULL.';
comment on column admin_action_logs.class_id is
    '예약 관련 액션에서만 채워짐. CLASS_CREATE/CLASS_UPDATE 같은 향후 액션은 이 컬럼 대신 별도 식별자를 쓸 수 있음.';

-- action_type: 지금 실제로 기록하는 4종 + 향후 예정된 값(아직 어떤 코드도 쓰지 않음, 스키마만 미리 확장)
alter table admin_action_logs drop constraint if exists admin_action_logs_action_type_check;
alter table admin_action_logs add constraint admin_action_logs_action_type_check
    check (action_type in (
        -- 예약 관련 (기존, 실제 사용 중)
        'CREATE_ASSIGNMENT', 'CREATE_FREE', 'CANCEL_ASSIGNMENT', 'CANCEL_FREE',
        -- 향후 예정 (아직 미사용 — 공지/수업/수강권 CRUD 감사로그 확장용으로 예약된 값)
        'NOTICE_CREATE', 'NOTICE_DELETE',
        'CLASS_CREATE', 'CLASS_UPDATE', 'CLASS_CANCEL',
        'MEMBERSHIP_CREATE', 'MEMBERSHIP_UPDATE'
    ));

-- ============================================================
-- 끝. admin_action_logs는 이제 예약 외 관리자 액션도 기록할 수 있는 구조가 되었습니다.
-- 새 action_type을 실제로 기록하는 코드는 이번 범위에서 추가하지 않았습니다(스키마 확장만).
-- ============================================================
