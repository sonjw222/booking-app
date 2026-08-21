-- rollback: add_delete_test_center_cascade_rpc.sql
-- ⚠ 이 함수를 삭제하면 tests/integration/auto-book-membership-security.test.ts의
--   createIsolatedOwnedCenter()가 다시 실패한다 — 코드도 함께 이전 커밋으로 되돌려야 한다.

drop function if exists delete_test_center_cascade(uuid);
