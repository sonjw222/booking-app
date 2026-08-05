-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- NOTIF-001 / RES-001 공통 선행 마이그레이션: reservations.cancel_source 컬럼 추가
--
-- ⚠️ 실행 순서: 이 파일을 반드시 먼저 실행해야 한다. 아래 두 파일이 이 컬럼을 참조한다:
--   - fix_reservation_cancel_grace_period_draft_proposed.sql (cancel_reservation, 'MEMBER'로 표시)
--   - fix_holiday_history_and_notification_draft_proposed.sql (add_holiday_safe, 'HOLIDAY'로 표시)
--
-- 목적: 예약이 취소된 "출처"를 회원 취소/관리자 취소/휴무일 자동취소로 구분해서 저장한다.
-- 기존 cancel_reason(자유 텍스트, 관리자가 직접 입력 가능)만으로는 "이 취소가 휴무일 자동
-- 취소인지"를 안정적으로 판별할 수 없어(관리자가 아무 텍스트나 입력 가능), 회원 알림
-- 문구를 취소 출처별로 다르게 만들려면 별도의 코드값이 필요하다.
--
-- 이번 배치에서 실제로 이 값을 쓰는 곳: add_holiday_safe('HOLIDAY'), cancel_reservation('MEMBER').
-- admin_cancel_reservation/manager_set_attendance는 이번 배치에서 손대지 않아 그 경로로 취소된
-- 예약은 cancel_source가 NULL로 남는다(기존 알림 문구 그대로 유지, 회귀 아님).
--
-- 기존 데이터 영향: 기존에 이미 취소된 예약은 전부 cancel_source가 NULL로 남는다(과거 취소
-- 출처를 소급 판별할 근거가 없으므로 NULL이 정확한 표현 — 굳이 추정해 채우지 않는다).
-- 예상 영향 행 수: 0건(컬럼 추가만, 데이터 UPDATE 없음).
-- 인덱스: 불필요.
-- RLS 영향: 없음(기존 reservations RLS 정책은 특정 컬럼을 언급하지 않음).
-- ============================================================

BEGIN;

alter table reservations
    add column if not exists cancel_source text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'reservations_cancel_source_check') then
        alter table reservations add constraint reservations_cancel_source_check
            check (cancel_source is null or cancel_source in ('MEMBER', 'ADMIN', 'HOLIDAY'));
    end if;
end $$;

comment on column reservations.cancel_source is
    '취소 출처(MEMBER=회원 셀프취소/ADMIN=관리자취소/HOLIDAY=휴무일 자동취소). null=구분 미기록(과거 데이터 또는 아직 이 값을 쓰지 않는 취소 경로)';

COMMIT;
