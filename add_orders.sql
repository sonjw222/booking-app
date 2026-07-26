-- ============================================================
-- 주문/결제: orders 테이블
--
-- 하는 일:
--   회원이 수강권/상품 결제(주문) → orders에 기록
--   매니저가 주문 관리에서 확인/발급/취소
--   결제 수단은 나중에 연동 (지금은 pending으로 접수)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create table if not exists orders (
    id            uuid primary key default gen_random_uuid(),
    center_id     uuid not null references centers(id) on delete cascade,
    profile_id    uuid not null references profiles(id) on delete cascade,
    product_id    uuid references products(id) on delete set null,
    product_name  text not null,
    amount        int not null default 0,
    pay_method    text,
    status        text not null default 'pending'
                  check (status in ('pending', 'paid', 'cancelled', 'done')),
    created_at    timestamptz not null default now(),
    paid_at       timestamptz
);

alter table orders enable row level security;

-- 회원: 본인 주문 생성/조회
drop policy if exists "주문 본인 생성" on orders;
create policy "주문 본인 생성"
    on orders for insert
    with check (profile_id in (select my_profile_ids()));

drop policy if exists "주문 본인 조회" on orders;
create policy "주문 본인 조회"
    on orders for select
    using (profile_id in (select my_profile_ids()));

-- 매니저: 자기 센터 주문 조회/수정
drop policy if exists "주문 매니저 조회" on orders;
create policy "주문 매니저 조회"
    on orders for select
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());

drop policy if exists "주문 매니저 수정" on orders;
create policy "주문 매니저 수정"
    on orders for update
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());


-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies where tablename = 'orders';


-- ============================================================
-- 완료!
--   회원: 센터 상세 → 구매 → 결제 화면 → 결제하기 → 주문 접수
--   매니저: 매니저 모드 → 주문 관리 → 확인 대기 → 발급 완료
--   ※ 실제 결제 수단(카드/카카오/토스)은 나중에 연동
-- ============================================================
