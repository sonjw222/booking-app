-- ============================================================
-- ensure_center_member(uuid, uuid) 실행 권한 축소 (P2, 2026-10-08)
-- ============================================================
-- 문제: 라이브 덤프에 이 함수의 REVOKE/GRANT가 없어 기본 ACL(PUBLIC EXECUTE)이 그대로라 anon/authenticated가 PostgREST로 직접 호출할 수 있다.
--       본문에 호출자 확인이 없어, 누구나 임의 센터의 center_members에 임의 프로필(자기 자신 포함)을 active로 넣을 수 있고
--       내부 QA 센터 가시성(my_member_center_ids)과 매니저 회원 목록을 오염시킬 수 있다.
-- 근거(호출처): app/ lib/ tests/ supabase/functions 어디서도 rpc("ensure_center_member")를 부르지 않는다. 라이브에서 이 함수를 호출하는 것은
--       SECURITY DEFINER 함수 confirm_test_payment, fulfill_order 뿐이다(소유자 권한으로 실행되므로 이 REVOKE의 영향을 받지 않는다).
-- 수정: PUBLIC/anon/authenticated의 EXECUTE를 회수하고 service_role에만 남긴다. 함수 본문/로직은 바꾸지 않는다.
-- 롤백: rollback_fix_ensure_center_member_privileges_20261008.sql / 확인: verify_fix_ensure_center_member_privileges_20261008.sql
-- ⚠ Claude Code 세션에서 실행되지 않았다 — 사용자가 SQL Editor에서 직접 확인 후 실행.
-- ============================================================

revoke all on function public.ensure_center_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ensure_center_member(uuid, uuid) to service_role;
