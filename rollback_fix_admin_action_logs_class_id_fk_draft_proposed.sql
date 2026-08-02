-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_admin_action_logs_class_id_fk_draft_proposed.sql was applied ⚠️
-- 롤백 — admin_action_logs.class_id를 수정 직전(not null, ON DELETE 미지정) 상태로 되돌린다.
--
-- ⚠️ 주의: fix_*.sql 적용 이후 실제로 class_id가 SET NULL로 비워진 행이 하나라도 생겼다면
-- (= 그 사이 add_holiday_safe로 관리자배치 예약이 있는 날의 수업이 삭제된 적이 있다면)
-- 아래 `alter column class_id set not null`이 NOT NULL 위반으로 실패한다. 그 경우 이 롤백을
-- 실행하기 전에 그런 행을 수동으로 처리(재연결 불가 — 원본 수업이 이미 삭제됨)할지 먼저
-- 판단해야 한다(reservation_id 롤백과 동일한 주의사항).
-- ============================================================

BEGIN;

alter table admin_action_logs
    drop constraint if exists admin_action_logs_class_id_fkey;

alter table admin_action_logs
    add constraint admin_action_logs_class_id_fkey
    foreign key (class_id) references classes(id);

alter table admin_action_logs
    alter column class_id set not null;

COMMIT;
