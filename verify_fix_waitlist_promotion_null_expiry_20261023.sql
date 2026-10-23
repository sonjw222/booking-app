-- 읽기 전용: 가드가 들어갔는지(적용 후 true), 그리고 영향 대상 규모(만료일 없는 활성 수강권을 가진 대기 중 예약 수)
select pg_get_functiondef('public.cancel_reservation(uuid)'::regprocedure) ~* 'expires_at\s+is\s+null\s+or\s+expires_at\s*>=\s*current_date' as has_null_guard;
select count(*) as waitlisted_with_no_expiry_pass
  from reservations r join memberships m on m.id = r.membership_id
 where r.status = 'waitlisted' and m.expires_at is null and m.status = 'active';
