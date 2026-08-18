-- ============================================================
-- ROLLBACK for fix_class_reservation_counts_add_waitlisted.sql
--
-- reservation_functions.sql:418-421의 원래 정의(confirmed_count만)로 복원한다.
-- ⚠ 이 롤백 실행 후에는 app/reservation/page.tsx의 대기 인원 표시가 다시 항상 0으로
-- 보인다(waitlisted_count 컬럼이 없어져 select 시 에러가 날 수 있음 — 프론트 코드도
-- 같이 되돌려야 함).
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace view class_reservation_counts as
select class_id, count(*)::int as confirmed_count
from reservations
where status = 'confirmed'
group by class_id;

grant select on class_reservation_counts to authenticated;

COMMIT;
