-- ============================================================
-- READ-ONLY 진단 — refund_membership() 환불 후 예약 잔존 문제 수정 전 확인.
-- SELECT만 사용. DB를 전혀 변경하지 않음.
--
-- refund_membership()/cancel_reservation() 둘 다 이 저장소에 여러 파일에
-- 흩어져 재정의돼 있어(refund_membership 2곳, cancel_reservation 4곳),
-- 실제 Live 본문을 먼저 확인한 뒤 그 본문 기준으로 수정 SQL을 작성한다
-- (fulfill_order 때와 동일한 이유 — 추측으로 CREATE OR REPLACE 했다가
-- 실제 Live에만 있던 분기를 지워버리는 사고를 막기 위함).
-- ============================================================

select pg_get_functiondef('refund_membership(uuid)'::regprocedure);

select pg_get_functiondef('cancel_reservation(uuid)'::regprocedure);

-- 참고: 이미 이 문제가 실제로 발생했는지(환불된 수강권인데 확정/대기 예약이 남아있는 경우)
select m.id as membership_id, m.status as membership_status, m.remaining_count, m.total_count,
       r.id as reservation_id, r.status as reservation_status, c.start_time
from memberships m
join reservations r on r.membership_id = m.id
join classes c on c.id = r.class_id
where m.status = 'refunded'
  and r.status in ('confirmed', 'waitlisted');
