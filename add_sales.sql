-- ============================================================
-- 매출 관리 기능 추가
--
-- 하는 일:
--   1) 결제 권한 3개를 카탈로그에 추가 (등록/수정/삭제)
--   2) payments / expenses / point_transactions RLS 정책
--      (지금은 RLS가 꺼져 있어 아무나 남의 센터 매출을 볼 수 있음 → 격리 필요)
--
-- DB 재생성 불필요. 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================


-- ------------------------------------------------------------
-- [1] 결제 권한 카탈로그 (없으면 추가)
-- ------------------------------------------------------------
insert into permissions (key, category, parent_key, label, description, sort_order)
values
    ('pass.payment.create', 'pass', null, '결제 등록', '회원 결제를 등록할 수 있습니다.', 11),
    ('pass.payment.update', 'pass', null, '결제 수정', '등록된 결제를 수정할 수 있습니다.', 12),
    ('pass.payment.delete', 'pass', null, '결제 삭제', '결제 내역을 삭제할 수 있습니다.', 13)
on conflict (key) do nothing;


-- ------------------------------------------------------------
-- [2] payments 정책
-- ------------------------------------------------------------
alter table payments enable row level security;

drop policy if exists "매니저 매출 조회" on payments;
create policy "매니저 매출 조회"
    on payments for select
    using (
        has_permission(center_id, 'pass.sales.view')
        or profile_id in (select my_profile_ids())
    );

drop policy if exists "매니저 매출 등록" on payments;
create policy "매니저 매출 등록"
    on payments for insert
    with check (has_permission(center_id, 'pass.payment.create'));

drop policy if exists "매니저 매출 수정" on payments;
create policy "매니저 매출 수정"
    on payments for update
    using (has_permission(center_id, 'pass.payment.update'))
    with check (has_permission(center_id, 'pass.payment.update'));

drop policy if exists "매니저 매출 삭제" on payments;
create policy "매니저 매출 삭제"
    on payments for delete
    using (has_permission(center_id, 'pass.payment.delete'));


-- ------------------------------------------------------------
-- [3] expenses 정책
-- ------------------------------------------------------------
alter table expenses enable row level security;

drop policy if exists "매니저 지출 조회" on expenses;
create policy "매니저 지출 조회"
    on expenses for select
    using (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 지출 등록" on expenses;
create policy "매니저 지출 등록"
    on expenses for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 지출 수정" on expenses;
create policy "매니저 지출 수정"
    on expenses for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 지출 삭제" on expenses;
create policy "매니저 지출 삭제"
    on expenses for delete
    using (center_id in (select my_managed_center_ids()));


-- ------------------------------------------------------------
-- [4] point_transactions 정책
-- ------------------------------------------------------------
alter table point_transactions enable row level security;

drop policy if exists "포인트 조회" on point_transactions;
create policy "포인트 조회"
    on point_transactions for select
    using (
        center_id in (select my_managed_center_ids())
        or profile_id in (select my_profile_ids())
    );

drop policy if exists "매니저 포인트 등록" on point_transactions;
create policy "매니저 포인트 등록"
    on point_transactions for insert
    with check (center_id in (select my_managed_center_ids()));


-- ============================================================
-- 확인
-- ============================================================
select tablename, count(*) as 정책수
from pg_policies
where tablename in ('payments', 'expenses', 'point_transactions')
group by tablename;


-- ============================================================
-- 완료!
--   → 오너 계정으로 매니저 대시보드 → "매출 관리"
--   → "+ 등록"으로 결제 입력 (분할결제·미수금·매출구분)
--   → 기간 바꿔가며 순매출/미수금/수단별 집계 확인
--
--   ※ 강사에게 매출을 보이려면 [역할별 권한] 또는 [개인 권한]에서
--     'pass.sales.view'(매출 열람)를 켜주세요. 오너는 항상 보입니다.
-- ============================================================
