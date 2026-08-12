-- ============================================================
-- fix_security_definer_hardening_search_path_execute_draft_proposed.sql 롤백
--
-- search_path 고정을 해제하고(RESET) EXECUTE를 PUBLIC으로 되돌린다.
-- 함수 로직 자체는 원래부터 이 배치에서 변경한 적이 없으므로 되돌릴 것도 없다.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

alter function reserve_class(uuid, uuid) reset search_path;
alter function reserve_with_membership(uuid, uuid, uuid) reset search_path;
alter function cancel_reservation(uuid) reset search_path;
alter function refund_membership(uuid) reset search_path;
alter function fulfill_order(uuid) reset search_path;
alter function usable_memberships(uuid, uuid) reset search_path;
alter function usable_memberships_for_classes(uuid[], uuid) reset search_path;
alter function is_platform_admin() reset search_path;

grant execute on function reserve_class(uuid, uuid) to public;
grant execute on function reserve_with_membership(uuid, uuid, uuid) to public;
grant execute on function cancel_reservation(uuid) to public;
grant execute on function refund_membership(uuid) to public;
grant execute on function fulfill_order(uuid) to public;

COMMIT;

-- ============================================================
-- 완료. 이 배치 적용 이전 상태로 정확히 복원됨.
-- ============================================================
