-- ============================================================
-- NICEPAY P2 롤백 준비 상태 확인(읽기 전용 · 2026-10-30) — 변경 없음. SQL Editor 에서 close_nicepay_review_20261029.sql 실행 뒤, rollback_add_nicepay_review_center_isolation_20261028.sql 실행 전에 본다.
-- 목적: 심사 센터에 일반 회원 관계가 남아 있어 P2 분리 정책을 지우면 그 회원에게 심사 센터가 보이게 되는지 미리 확인한다.
--   (실제 가시성 측정은 롤백 SQL 이 직접 하고, 늘어난 계정이 있으면 스스로 중단한다. 이 파일은 그 이유를 미리 보여 주는 용도.)
-- 판정: ① 이 값들이 모두 0 이면 롤백이 노출을 늘리지 않을 가능성이 높다. ② 0 이 아니면 회원·프로필·주문·수강권·예약을 지우지 말고, P2 를 그대로 두는 것을 권장한다(일반 사용자에게는 이미 보이지 않는다).
-- ============================================================
select
  (select count(*) from centers where is_nicepay_review and not is_internal and status = 'approved')                           as publicly_visible_review_centers_must_be_0,
  (select count(*) from center_members cm join centers c on c.id = cm.center_id where c.is_nicepay_review)                       as center_member_rows_must_be_0,
  (select count(*) from memberships m join centers c on c.id = m.center_id where c.is_nicepay_review)                            as memberships_info,
  (select count(*) from orders o join centers c on c.id = o.center_id where c.is_nicepay_review)                                 as orders_info,
  (select count(*) from cart_items x join centers c on c.id = x.center_id where c.is_nicepay_review)                             as cart_items_info,
  (select count(*) from purchase_requests x join centers c on c.id = x.center_id where c.is_nicepay_review)                      as purchase_requests_info,
  (select count(*) from reservations r join classes cl on cl.id = r.class_id join centers c on c.id = cl.center_id where c.is_nicepay_review) as reservations_info,
  (select count(*) from manager_centers mc join centers c on c.id = mc.center_id where c.is_nicepay_review)                      as manager_rows_info_intended_access,
  (select count(*) from orders where payment_provider = 'nicepay' and status = 'approving')                                       as in_flight_approving_orders_must_be_0,
  (select mode from nicepay_checkout_gate where id)                                                                               as gate_mode_must_be_off,
  to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is not null                                                  as p2b_still_applied_rollback_p2b_first;
-- 롤백을 막을 수 있는 계정(식별자만): 심사 센터에 회원 등록이 있는 계정
select cm.center_id, p.account_id, cm.profile_id, cm.registered_at
  from center_members cm join centers c on c.id = cm.center_id and c.is_nicepay_review join profiles p on p.id = cm.profile_id
 order by cm.registered_at limit 50;
