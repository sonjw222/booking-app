-- 읽기 전용(SELECT 만) — 운영 SQL Editor 에서 사용자가 실행. 데이터·권한을 바꾸지 않는다. 비밀번호·토큰·해시는 조회하지 않고 이메일은 마스킹한다.
-- 목적: NICEPAY 요청(실제 판매 예정 상품으로 심사 경로 구성 + 로그인 가능한 테스트 계정) 진행 전 현재 상태 확인.
-- A10TION 피겨팀 센터 ID: 8965e09c-0d2b-44c6-ab26-40a85507f8b5 / NICEPAY 심사 계정 UID: 7ffcf57d-b6d1-4562-a260-33be15f66ee5 (niceqa@mwhabit.com)

-- 1) A10TION 센터: 상태, 오너(마스킹)·활성 매니저 수 — 심사관에게 상품을 보여 주는 것에 대한 센터 운영자 동의 주체 확인
select c.id, c.name, c.status, c.is_internal, c.is_nicepay_review,
       (select count(*) from manager_centers mc where mc.center_id = c.id and mc.status = 'active') as active_managers,
       (select string_agg(distinct left(u.email, 3) || '***' || substring(u.email from '@.*$'), ', ')
          from manager_centers mc join center_roles cr on cr.id = mc.role_id and cr.is_owner join accounts a on a.id = mc.account_id left join auth.users u on u.id = a.auth_id
         where mc.center_id = c.id and mc.status = 'active') as owner_email_masked
from centers c where c.id = '8965e09c-0d2b-44c6-ab26-40a85507f8b5';

-- 2) A10TION 상품 전체: 판매 상태·공개 범위·만료·가격 — 심사 경로에 쓸 "정상 상품 후보"(is_sellable_now=true)
select p.id, p.name, p.price, p.product_kind, p.pass_type, p.total_count, p.purchase_count_selectable, p.is_active, p.is_on_sale, p.visibility_type,
       p.expiry_mode, p.expiry_date, p.expiry_days,
       (p.is_active and p.is_on_sale and not coalesce(p.expiry_mode = 'date' and p.expiry_date < (now() at time zone 'Asia/Seoul')::date, false)) as is_sellable_now,
       left(coalesce(p.description, ''), 60) as description_head
from products p where p.center_id = '8965e09c-0d2b-44c6-ab26-40a85507f8b5' order by is_sellable_now desc, p.price, p.name;

-- 3) 심사 계정(niceqa): 권한 점검 — 기대: nicepay_review_access=true, is_member=true, 매니저 소속 0, is_platform_admin=false, 탈퇴/병합 아님, 이메일 인증됨
select a.id as account_id, a.is_member, a.is_platform_admin, a.nicepay_review_access, a.pg_checkout_override, a.deactivated_at is not null as deactivated, a.merged_into is not null as merged,
       (u.email_confirmed_at is not null) as email_confirmed, left(u.email, 3) || '***' || substring(u.email from '@.*$') as email_masked,
       (select string_agg(distinct i.provider, ',') from auth.identities i where i.user_id = u.id) as login_providers,
       (select count(*) from manager_centers mc where mc.account_id = a.id) as manager_links,
       (select count(*) from center_members cm where cm.profile_id in (select id from profiles where account_id = a.id)) as center_member_rows,
       (select count(*) from orders o where o.profile_id in (select id from profiles where account_id = a.id)) as orders
from auth.users u join accounts a on a.auth_id = u.id where u.id = '7ffcf57d-b6d1-4562-a260-33be15f66ee5';
select count(*) as reviewer_accounts_total, count(*) filter (where pg_checkout_override) as toss_override_accounts from accounts where nicepay_review_access;
select count(*) as platform_admin_accounts_for_reference from accounts where is_platform_admin;

-- 4) 현재 심사 센터(테스트 상품)와 허용 목록 적용 여부
select c.id, c.name, c.status, c.is_internal, c.is_nicepay_review,
       (select count(*) from products p where p.center_id = c.id and p.is_active and p.is_on_sale) as sellable_products
from centers c where c.id = '1c02c063-8da4-43b5-b88a-514434371c46';
select to_regclass('public.nicepay_review_center_grants') as grants_table,
       to_regprocedure('public.nicepay_my_review_center_ids()') as grants_rpc,
       to_regprocedure('public.fixed_expiry_passed(text,date)') as expired_hide_fn,
       (select count(*) from pg_policies where policyname = 'nicepay_review_isolation') as p2_policies;
-- 허용 SQL 적용 전 함수 MD5 (적용 전이면 636cb33f… / a3a299f7… / 0e8dc90f… 와 같아야 한다)
select 'nicepay_review_center_allowed' as fn, md5(pg_get_functiondef('public.nicepay_review_center_allowed(uuid)'::regprocedure)) as md5
union all select 'nicepay_review_center_member_allowed', md5(pg_get_functiondef('public.nicepay_review_center_member_allowed(uuid)'::regprocedure))
union all select 'nicepay_review_guard_center', md5(pg_get_functiondef('public.nicepay_review_guard_center()'::regprocedure));
