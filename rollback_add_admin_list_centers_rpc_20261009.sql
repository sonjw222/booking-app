-- 롤백: admin_list_centers RPC 제거(SQL 1 취소). 반드시 SQL 2(컬럼 권한)를 먼저 롤백한 뒤 실행 —
-- 컬럼 권한이 막힌 상태에서 이 함수를 지우면 관리자 승인 화면이 센터 목록을 읽을 방법이 없다.
begin;
drop function if exists public.admin_list_centers(text);
commit;
