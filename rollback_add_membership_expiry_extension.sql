-- ============================================================
-- add_membership_expiry_extension.sql 롤백 — 가드 트리거/RPC 2개/permission 제거, sort_order 복원.
-- ⚠ 롤백하면 클라이언트의 extend_passes_after_dormant 호출은 "함수 없음" 폴백으로 예전 직접 UPDATE 경로를 쓰고,
--   issue_pass/pass_detail 직원의 expires_at 직접 UPDATE가 다시 가능해진다(이 migration 이전 상태).
--   이미 남은 admin_action_logs(EXPIRY_EXTEND) 기록과 연장된 만료일 데이터는 되돌리지 않는다.
-- ============================================================
BEGIN;

drop trigger if exists memberships_guard_expiry_update on memberships;
drop function if exists memberships_guard_expiry_update();
drop function if exists manager_extend_membership_expiry(uuid, text, integer, date, text);
drop function if exists extend_passes_after_dormant(uuid);

-- 역할/개인에 이 권한이 켜져 있었다면 함께 정리(카탈로그 항목이 사라지므로)
delete from role_permissions where permission_key = 'customer.member.pass_expiry.update';
delete from account_center_permissions where permission_key = 'customer.member.pass_expiry.update';
delete from permissions where key = 'customer.member.pass_expiry.update';
update permissions set sort_order = 18 where key = 'customer.member.assign_any_status' and sort_order = 19;

COMMIT;
