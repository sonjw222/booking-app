-- ============================================================
-- customer.member.pass_detail 전체 범위 연결 (P2-31 후속)
--
-- 배경: 이전 배치(fix_customer_member_pass_detail_permission.sql)는 이 키를
-- membership_transfers(양도 이력) SELECT 하나에만 연결했다. 카탈로그 라벨의 진짜
-- 핵심("회원에게 발급된 수강권 상세정보를 조회, 수정할 수 있습니다. 포인트 및
-- 결제내역을 조회할 수 있습니다")은 memberships/payments 테이블 자체다 — 지금까지
-- 안 걸려있었다. 사용자 확인(2026-09-09)으로 이어서 완성한다.
--
-- ⚠ 두 정책 모두 "narrowing"이 아니라 "widening"(OR 추가)이다 — 기존 조건은 그대로
-- 두고 customer.member.pass_detail을 추가 대안으로만 얹는다. 회원목록/매출관리 등
-- 다른 화면이 memberships/payments를 다른 목적(customer.member.view, pass.sales.view)
-- 으로도 읽고 있어서, 완전히 이 키로 교체하면 그 화면들이 갑자기 깨진다 — 그래서
-- "이 키만 있어도 회원 상세 화면에서 수강권/결제 내역을 볼 수 있게" OR로만 넓힌다.
-- 기존 스태프 접근은 전혀 줄어들지 않는다(breaking change 아님).
--
-- 포인트(point_balances 등) 조회의 매니저용(회원 상세화면에서 특정 회원 것 조회) 경로는
-- 코드 전체에 없음을 확인(grep 0건, lib/members.ts에 point 관련 필드 자체가 없음) —
-- 카탈로그 라벨이 아직 안 만들어진 기능을 가리키고 있는 것으로 보임. 새 UI를 만들지
-- 않고 그대로 보고한다(별도 결정 필요, docs/TODO.md에 기록).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- memberships: SELECT에 pass_detail 추가, UPDATE에도 pass_detail 추가
-- (기존 조건은 그대로 유지 — fix_membership_rls.sql 기준)
-- ------------------------------------------------------------
drop policy if exists "매니저 수강권 조회" on memberships;
create policy "매니저 수강권 조회"
    on memberships for select
    using (
        profile_id in (select my_profile_ids())
        or has_permission(center_id, 'customer.member.view')
        or has_permission(center_id, 'customer.member.pass_detail')
        or is_platform_admin()
    );

drop policy if exists "매니저 수강권 수정" on memberships;
create policy "매니저 수강권 수정"
    on memberships for update
    using (
        has_permission(center_id, 'customer.member.issue_pass')
        or has_permission(center_id, 'customer.member.pass_detail')
        or is_platform_admin()
    )
    with check (
        has_permission(center_id, 'customer.member.issue_pass')
        or has_permission(center_id, 'customer.member.pass_detail')
        or is_platform_admin()
    );

-- ------------------------------------------------------------
-- payments: SELECT에 pass_detail 추가 (기존 pass.sales.view/본인조회는 그대로 유지)
-- ------------------------------------------------------------
drop policy if exists "매니저 매출 조회" on payments;
create policy "매니저 매출 조회"
    on payments for select
    using (
        has_permission(center_id, 'pass.sales.view')
        or has_permission(center_id, 'customer.member.pass_detail')
        or profile_id in (select my_profile_ids())
        or is_platform_admin()
    );

-- ============================================================
-- 확인
-- ============================================================
select tablename, policyname, cmd from pg_policies
where tablename in ('memberships', 'payments')
order by tablename, cmd;
