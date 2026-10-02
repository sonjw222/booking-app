-- 이 migration이 추가한 RPC만 제거한다(원본 테이블/정책/권한은 변경한 적이 없다). 웹을 되돌리지 않고 실행하면 비로그인 구매 화면의 예약조건은 다시 비어 보인다(오류는 아님).
begin;
drop function if exists public.fetch_public_product_schedule_rules(uuid);
commit;
