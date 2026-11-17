-- 롤백: 주문 사이즈 서버 검증 제거(트리거·함수만 삭제 — 데이터 무관, 멱등). 제안·미실행.
BEGIN;
drop trigger if exists orders_validate_selected_size on public.orders;
drop function if exists public.orders_validate_selected_size();
COMMIT;
