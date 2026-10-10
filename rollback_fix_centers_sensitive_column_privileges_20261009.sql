-- 롤백: centers SELECT 권한을 적용 전(테이블 전체)으로 복구. 데이터 손실 없음, 즉시 효과.
-- ⚠ 이 롤백은 민감 컬럼 노출을 다시 연다 — 긴급 장애 복구용.
begin;
grant select on table public.centers to anon, authenticated;
commit;
