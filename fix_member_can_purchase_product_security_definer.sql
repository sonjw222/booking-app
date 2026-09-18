-- ============================================================
-- MWHABIT Membership Visibility Batch — CORRECTIVE PATCH: member_can_purchase_product에
-- SECURITY DEFINER 누락 수정
-- ============================================================
-- 실측으로 발견한 버그: member_can_purchase_product()를 처음 만들 때 실수로
-- SECURITY DEFINER를 빠뜨렸다(기본값은 SECURITY INVOKER — 호출한 세션의 권한으로
-- 실행됨). 그 결과 이 함수 내부의 membership_product_grades/membership_product_members
-- 조회가 "매니저만 조회 가능"인 RLS 정책에 걸려, 일반 회원 세션에서 호출하면 실제로
-- 매핑이 있어도 항상 0건으로 보여 구매 자격이 무조건 false로 나왔다(회원용 실사용
-- 경로에서만 재현됨 — service_role/관리자로 직접 호출하면 RLS를 우회해서 정상으로
-- 보였기 때문에 스모크 테스트에서는 못 잡았고, 실제 회원 세션 기준 QA 시나리오에서
-- [24-2]/[24-3]/[24-4]/[24-19] 4건이 실패하면서 실측으로 잡혔다).
--
-- fetch_purchasable_products()는 처음부터 SECURITY DEFINER로 올바르게 만들었으므로
-- (원래 목록 조회는 이 문제가 없었음) 이 함수만 고치면 된다. 함수 본문/시그니처는
-- 전혀 바꾸지 않고 SECURITY DEFINER + search_path 고정만 추가한다(반환 타입이
-- 그대로라 CREATE OR REPLACE로 안전하게 교체 가능 — update_class_safe 때와 달리
-- DROP이 필요 없다).
-- ============================================================

create or replace function member_can_purchase_product(p_product_id uuid, p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((
        select
            case p.visibility_type
                when 'all' then true
                when 'grades' then exists (
                    select 1 from membership_product_grades mpg
                    join center_members cm
                      on cm.center_id = p.center_id
                     and cm.profile_id = p_profile_id
                     and cm.grade_id = mpg.grade_id
                    where mpg.product_id = p.id
                )
                when 'selected_members' then exists (
                    select 1 from membership_product_members mpm
                    join center_members cm
                      on cm.center_id = p.center_id
                     and cm.profile_id = p_profile_id
                     and cm.id = mpm.center_member_id
                    where mpm.product_id = p.id
                )
                else false
            end
        from products p
        where p.id = p_product_id
          and p.is_active
          and p.is_on_sale
    ), false);
$$;

-- ============================================================
-- 확인(read-only)
-- ============================================================
-- select prosecdef from pg_proc where proname = 'member_can_purchase_product';
-- (prosecdef = true 여야 정상 — SECURITY DEFINER 적용 확인)
