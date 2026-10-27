-- 로컬 격리 DB 전용 페르소나 설정
update accounts set pg_checkout_override = true where auth_id = (select id from auth.users where email = :'ub');
insert into manager_centers(account_id, center_id, status) select (select id from accounts where auth_id=(select id from auth.users where email=:'ma')), id, 'active' from centers where name='[QA] 심사 시험 스튜디오';
insert into manager_centers(account_id, center_id, status) select (select id from accounts where auth_id=(select id from auth.users where email=:'mb')), id, 'active' from centers where is_nicepay_review;
-- 운영 센터 회원 이력: 일반 회원 A, 심사관 B 모두 운영 센터에 기존 수강권·주문·예약 이력을 둔다(보존 확인용)
insert into center_members(center_id, profile_id) select c.id, p.id from centers c, profiles p where c.name='[QA] 심사 시험 스튜디오' and p.id in (select pr.id from profiles pr join accounts a on a.id=pr.account_id where a.auth_id in (select id from auth.users where email in (:'ua',:'ub'))) on conflict do nothing;
insert into memberships(profile_id, center_id, product_name, pass_type, total_count, remaining_count, product_id)
select p.id, c.id, '[QA] 8회권 · 30일', 'count', 8, 8, (select id from products where name='[QA] 8회권 · 30일') from centers c, profiles p
where c.name='[QA] 심사 시험 스튜디오' and p.id in (select pr.id from profiles pr join accounts a on a.id=pr.account_id where a.auth_id in (select id from auth.users where email in (:'ua',:'ub')));
insert into classes(center_id, title, start_time, end_time, capacity) select id, '[QA] 운영 센터 수업', now()+interval '2 days', now()+interval '2 days 1 hour', 10 from centers where name='[QA] 심사 시험 스튜디오';
insert into classes(center_id, title, start_time, end_time, capacity) select id, '[심사용] 시험 수업', now()+interval '2 days', now()+interval '2 days 1 hour', 10 from centers where is_nicepay_review;
