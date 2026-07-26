-- ============================================================
-- 센터 상세 개편: 구매 신청 + (상품/수강권 판매)
--
-- 하는 일:
--   purchase_requests 테이블 (회원이 앱에서 수강권/상품 구매 신청)
--   → 온라인 결제 붙기 전 단계: 매니저가 확인 후 처리
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create table if not exists purchase_requests (
    id           uuid primary key default gen_random_uuid(),
    center_id    uuid not null references centers(id) on delete cascade,
    profile_id   uuid not null references profiles(id) on delete cascade,
    product_id   uuid references products(id) on delete set null,
    product_name text not null,
    status       text not null default 'pending'
                 check (status in ('pending', 'done', 'cancelled')),
    created_at   timestamptz not null default now()
);

alter table purchase_requests enable row level security;

-- 회원: 본인 신청 생성/조회
drop policy if exists "구매신청 본인 생성" on purchase_requests;
create policy "구매신청 본인 생성"
    on purchase_requests for insert
    with check (profile_id in (select my_profile_ids()));

drop policy if exists "구매신청 본인 조회" on purchase_requests;
create policy "구매신청 본인 조회"
    on purchase_requests for select
    using (profile_id in (select my_profile_ids()));

-- 매니저: 자기 센터 신청 조회/수정
drop policy if exists "구매신청 매니저 조회" on purchase_requests;
create policy "구매신청 매니저 조회"
    on purchase_requests for select
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());

drop policy if exists "구매신청 매니저 수정" on purchase_requests;
create policy "구매신청 매니저 수정"
    on purchase_requests for update
    using (center_id in (select my_managed_center_ids()));


-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies where tablename = 'purchase_requests';


-- ============================================================
-- 완료!
--   회원: 센터 상세 → 수강권/상품 "구매" → 신청 기록
--   ※ 실제 결제·발급은 매니저가 확인 후 처리 (온라인 결제는 2차)
-- ============================================================
