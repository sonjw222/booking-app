-- 격리 RLS 검증용 시드(테스트 전용 UUID/이름). service 권한으로 준비만 한다.
\set uA '11111111-1111-1111-1111-111111111111'
\set uB '22222222-2222-2222-2222-222222222222'
\set uM '33333333-3333-3333-3333-333333333333'
insert into auth.users(id,email) values (:'uA','a@test.invalid'),(:'uB','b@test.invalid'),(:'uM','m@test.invalid');
insert into accounts(id,auth_id,name) values
 ('a0000000-0000-0000-0000-00000000000a',:'uA','일반회원A'),
 ('b0000000-0000-0000-0000-00000000000b',:'uB','일반회원B'),
 ('c0000000-0000-0000-0000-00000000000c',:'uM','센터관리자');
insert into profiles(id,account_id,name,label,is_primary) values
 ('a1000000-0000-0000-0000-0000000000a1','a0000000-0000-0000-0000-00000000000a','일반회원A',null,true),
 ('a2000000-0000-0000-0000-0000000000a2','a0000000-0000-0000-0000-00000000000a','자녀A','가족',false),
 ('b1000000-0000-0000-0000-0000000000b1','b0000000-0000-0000-0000-00000000000b','일반회원B',null,true),
 ('c1000000-0000-0000-0000-0000000000c1','c0000000-0000-0000-0000-00000000000c','센터관리자',null,true);
insert into centers(id,name,status) values
 ('c0a00000-0000-0000-0000-00000000c0a0','[QA] 공개 스튜디오','approved'),
 ('c0b00000-0000-0000-0000-00000000c0b0','[QA] 비공개 스튜디오','pending');
insert into center_settings(center_id) values ('c0a00000-0000-0000-0000-00000000c0a0'),('c0b00000-0000-0000-0000-00000000c0b0');
-- 센터 오너(센터 생성 트리거가 만든 owner 역할 사용)
insert into manager_centers(account_id,center_id,role_id,status)
 select 'c0000000-0000-0000-0000-00000000000c','c0a00000-0000-0000-0000-00000000c0a0',(select id from center_roles where center_id='c0a00000-0000-0000-0000-00000000c0a0' and is_owner limit 1),'active';
insert into products(id,center_id,name,price,product_kind,total_count,is_active,is_on_sale) values
 ('e1000000-0000-0000-0000-0000000000e1','c0a00000-0000-0000-0000-00000000c0a0','[QA] 공개 무료권',1000,'pass',3,true,true),
 ('e2000000-0000-0000-0000-0000000000e2','c0a00000-0000-0000-0000-00000000c0a0','[QA] 다른 수강권',50000,'pass',10,true,true),
 ('e3000000-0000-0000-0000-0000000000e3','c0b00000-0000-0000-0000-00000000c0b0','[QA] 비공개 센터 상품',50000,'pass',10,true,true);
insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode) values
 ('d1000000-0000-0000-0000-0000000000d1','c0a00000-0000-0000-0000-00000000c0a0','[QA] 지정 수강권 수업', now()+interval '3 days', now()+interval '3 days 1 hour', 5,'open','selected'),
 ('d2000000-0000-0000-0000-0000000000d2','c0a00000-0000-0000-0000-00000000c0a0','[QA] 전체 허용 수업', now()+interval '4 days', now()+interval '4 days 1 hour', 5,'open','all'),
 ('d3000000-0000-0000-0000-0000000000d3','c0b00000-0000-0000-0000-00000000c0b0','[QA] 비공개 센터 수업', now()+interval '3 days', now()+interval '3 days 1 hour', 5,'open','all');
insert into class_allowed_products(class_id,product_id) values ('d1000000-0000-0000-0000-0000000000d1','e1000000-0000-0000-0000-0000000000e1');
-- 제한 공개 상품(지정 회원 전용) — 공개 목록에 나오면 안 된다
insert into products(id,center_id,name,price,product_kind,total_count,is_active,is_on_sale,visibility_type) values
 ('e4000000-0000-0000-0000-0000000000e4','c0a00000-0000-0000-0000-00000000c0a0','[QA] 지정 회원 전용권',30000,'pass',5,true,true,'selected_members');
-- 다른 계정(B)의 유료 수강권 + 결제 — A에게 보이면 안 된다
insert into memberships(id,profile_id,center_id,product_id,product_name,total_count,remaining_count,status)
 values ('f2000000-0000-0000-0000-0000000000f2','b1000000-0000-0000-0000-0000000000b1','c0a00000-0000-0000-0000-00000000c0a0','e2000000-0000-0000-0000-0000000000e2','[QA] 다른 수강권',10,10,'active');
insert into payments(profile_id,center_id,membership_id,sale_type,total_amount,status,paid_at)
 values ('b1000000-0000-0000-0000-0000000000b1','c0a00000-0000-0000-0000-00000000c0a0','f2000000-0000-0000-0000-0000000000f2','new',50000,'paid',now());
