-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- P0-6 후속 발견: admin_action_logs.class_id도 reservation_id와 동일한 FK 위반 버그
--
-- 배경: fix_holiday_membership_restore_draft_proposed.sql(이미 실행됨)에서
-- admin_action_logs.reservation_id의 ON DELETE 미지정 FK를 nullable + ON DELETE SET NULL로
-- 고쳤다. 그 SQL 실행 후 holiday-membership-restore.test.ts를 재실행한 결과, 이번에는
-- `delete from classes where id = any(v_class_ids)` 단계에서 **다른 FK**
-- (`admin_action_logs_class_id_fkey`)가 걸려 여전히 add_holiday_safe()가 실패한다:
--
--   update or delete on table "classes" violates foreign key constraint
--   "admin_action_logs_class_id_fkey" on table "admin_action_logs"
--
-- 원인은 reservation_id와 완전히 동일하다 — admin_action_logs.class_id도
-- `not null references classes(id)`로, ON DELETE 지정이 없어(기본 RESTRICT) 관리자 직접배치/
-- 무료배치 로그가 있는 수업은 클래스 삭제 자체가 막힌다. add_admin_assignment.sql의
-- admin_action_logs 테이블 정의를 전수 재확인한 결과, add_holiday_safe()가 실제로 삭제하는
-- 테이블(reservations, classes)을 참조하는 not null FK는 이 두 컬럼(reservation_id,
-- class_id)뿐이었다 — center_id/admin_id/member_profile_id는 add_holiday_safe가 지우지
-- 않는 테이블을 참조해 영향 없고, membership_id/source_unassigned_id는 이미 nullable이며
-- add_holiday_safe가 memberships를 삭제하지 않으므로(remaining_count만 UPDATE) 영향 없다.
--
-- 수정: reservation_id와 동일한 패턴 — class_id를 nullable + ON DELETE SET NULL로 변경.
-- class_title_snapshot/class_start_snapshot 스냅샷 컬럼이 이미 있어 class_id가 null이 돼도
-- 로그의 의미는 유지된다.
--
-- 영향: lib/adminAssignment.ts의 AdminActionLog.classId 타입도 string | null로 맞춰야
-- 한다(아래에 함께 포함). reservation_id 때와 동일하게, 현재 이 필드를 실제로 읽는 화면
-- 코드가 없어(app/manager/admin-assignments/page.tsx 확인) 런타임 영향은 없다.
-- ============================================================

BEGIN;

alter table admin_action_logs
    alter column class_id drop not null;

alter table admin_action_logs
    drop constraint if exists admin_action_logs_class_id_fkey;

alter table admin_action_logs
    add constraint admin_action_logs_class_id_fkey
    foreign key (class_id) references classes(id) on delete set null;

COMMIT;
