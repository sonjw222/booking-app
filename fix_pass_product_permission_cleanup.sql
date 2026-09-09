-- ============================================================
-- P2-31 — pass.product.view / pass.product.manage 죽은 키 정리
--
-- 배경: add_new_permissions.sql이 만든 이 두 키는 실제로 어디에도(RLS/RPC/앱 코드)
-- 연결된 적이 없다. products 테이블의 실제 RLS는 원래부터 있던 pass.create/pass.update
-- (schema.sql)를 쓰고 있어서, 이 둘은 완전히 중복된 유령 정의였다(2026-09-09 P2-31
-- 전수 대조에서 발견, 사용자 확인 후 삭제 결정).
--
-- 기능 손실 없음 — pass.create/pass.update가 상품 관리 권한을 이미 담당하고 있다.
--
-- 여러 번 실행해도 안전.
-- ============================================================

delete from role_permissions where permission_key in ('pass.product.view', 'pass.product.manage');
delete from permissions where key in ('pass.product.view', 'pass.product.manage');

-- ============================================================
-- 확인 (0행이어야 정상)
-- ============================================================
select key from permissions where key in ('pass.product.view', 'pass.product.manage');
