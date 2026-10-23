-- ============================================================
-- [감사 F01·F05] 관리자가 지급한 쿠폰이 회원 화면에 보이지 않음
--
-- 확정된 원인(운영 pg_policies 읽기 전용 확인 + 격리 재현, 2026-10-22):
--   coupons / coupon_products 에는 "관리자(센터 매니저)" 정책만 있고 회원 조회 정책이 없다. member_coupons 에만 "내 쿠폰 조회" 정책이 있다.
--   앱의 fetchMyCoupons 는 member_coupons 를 읽으면서 coupons(...)를 임베드하는데, 회원은 coupons 를 읽을 수 없어 임베드가 null 이 되고
--   앱이 "정의 없는 고아 행"으로 보고 걸러내 → 지급된 쿠폰이 화면에서 사라진다(정상 빈 목록처럼 보임). 구매 화면의 coupon_products 조회도 같은 이유로 빈 결과.
--
-- 해결(최소 범위): coupons / coupon_products 를 회원에게 열지 않고, "내게 지급된 쿠폰"과 그 쿠폰 정의·적용 상품만 돌려주는 조회 함수.
--   · security definer 이지만 where 가 my_profile_ids() 소속 center_members 의 member_coupons 로 고정 → 타인 지급 내역, 미지급 쿠폰, 타 센터 자료는 반환되지 않는다.
--   · anon 실행 불가. 결제 시 서버의 쿠폰 자격 검증(_order_expected_amount)은 그대로다.
-- 적용: SQL Editor에 파일 전체(여러 번 실행해도 안전). 되돌리기: drop function my_member_coupons();
-- ============================================================
create or replace function my_member_coupons()
returns table (
    id                   uuid,      -- member_coupons.id
    status               text,
    issued_at            timestamptz,
    used_at              timestamptz,
    coupon_id            uuid,
    name                 text,
    center_id            uuid,
    center_name          text,
    discount_type        text,
    discount_value       int,
    max_discount_amount  int,
    minimum_order_amount int,
    applies_to           text,
    valid_from           timestamptz,
    valid_until          timestamptz,
    coupon_status        text,
    product_ids          uuid[]     -- applies_to='selected' 일 때 적용 대상 수강권
)
language sql
stable
security definer
set search_path = public
as $$
    select mc.id, mc.status, mc.issued_at, mc.used_at,
           c.id, c.name, c.center_id, ce.name,
           c.discount_type, c.discount_value, c.max_discount_amount, c.minimum_order_amount,
           c.applies_to, c.valid_from, c.valid_until, c.status,
           coalesce((select array_agg(cp.product_id) from coupon_products cp where cp.coupon_id = c.id), '{}'::uuid[])
    from member_coupons mc
    join coupons c on c.id = mc.coupon_id
    join centers ce on ce.id = c.center_id
    where mc.center_member_id in (
        select cm.id from center_members cm where cm.profile_id in (select my_profile_ids())
    )
    order by mc.issued_at desc;
$$;

revoke all on function my_member_coupons() from public, anon;
grant execute on function my_member_coupons() to authenticated;
notify pgrst, 'reload schema';
