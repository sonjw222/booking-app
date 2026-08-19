-- ============================================================
-- fix_center_info_sensitive_fields_permission_draft_proposed.sql 롤백
--
-- pay_methods/review_point 변경 가드 트리거와 헬퍼 함수를 제거해 적용 이전 상태
-- (센터 소속 active 스태프면 role/권한과 무관하게 이 두 필드도 자유롭게 수정 가능)로
-- 되돌린다. ⚠ 이 롤백은 P1-13이 다시 지적한 문제(결제수단/포인트를 아무 스태프나 바꿀 수
-- 있음)를 그대로 복원한다 — 회귀 테스트가 실제로 이 트리거 때문에 실패하는 것으로 확인된
-- 경우에만 사용할 것.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

drop trigger if exists guard_center_sensitive_fields_change_trigger on centers;
drop function if exists guard_center_sensitive_fields_change();
drop function if exists is_center_owner(uuid);

COMMIT;

-- ============================================================
-- 완료. centers 테이블이 이 트리거 적용 이전 상태로 복원됨(다른 필드 RLS는 이 배치가
-- 애초에 건드리지 않았으므로 영향 없음).
-- ============================================================
