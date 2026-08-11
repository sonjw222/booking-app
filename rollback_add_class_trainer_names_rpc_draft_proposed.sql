-- ============================================================
-- add_class_trainer_names_rpc_draft_proposed.sql 롤백
--
-- class_trainer_names(uuid[]) 함수를 제거한다. accounts/class_trainers 테이블 자체나
-- 기존 RLS 정책은 이 Batch가 전혀 건드리지 않았으므로 함수 삭제만으로 정확히
-- 원상복구된다.
--
-- [2026-08-11 권한 최소화 반영 후 재확인] DROP FUNCTION은 그 함수에 걸린 REVOKE/GRANT
-- 상태(public/anon 차단, authenticated 허용)를 포함해 함수 객체 자체를 통째로 제거한다
-- — 별도로 권한을 되돌리는 REVOKE/GRANT 문을 추가할 필요가 없다. 이 한 줄만으로
-- add_*.sql이 만든 모든 것(함수 본문 + 권한 설정)이 정확히 원상복구된다.
--
-- 여러 번 실행해도 안전(drop function if exists 가드 포함).
-- ============================================================

drop function if exists class_trainer_names(uuid[]);

-- ============================================================
-- 완료. class_trainer_names(uuid[]) 함수 제거됨.
-- ⚠ 이 롤백을 실행하면 lib/reservations.ts가 이 RPC를 호출하도록 이미 수정돼 있을 경우
-- fetchMonthData()가 즉시 에러를 낸다 — 코드도 함께 이전 버전으로 되돌리거나, 이 SQL
-- 롤백 전에 코드부터 되돌릴 것.
-- ============================================================
