-- ============================================================
-- MWHABIT Membership Visibility + Coupon Batch — CORRECTIVE PATCH: 권한(GRANT) 누락 수정
-- ============================================================
-- 실측으로 발견: add_membership_visibility_and_coupons.sql이 새로 만든 5개 테이블
-- (membership_product_grades/membership_product_members/coupons/coupon_products/
-- member_coupons)에 service_role로 SELECT를 시도해도 "permission denied for table
-- X" 오류가 났다 — 이건 RLS 위반이 아니라(RLS 위반이면 0건으로 조용히 걸러지거나
-- 다른 문구가 뜸) 테이블 자체에 대한 기본 GRANT가 없다는 뜻이다. 이 저장소의 기존
-- 테이블들(schema.sql)은 전부 명시적 grant 문이 없고 Supabase 프로젝트의 기본 권한
-- 체계(스키마 기본 권한)에 의존해왔는데, 이번에 새로 만든 5개 테이블에는 그 기본
-- 권한이 적용되지 않은 것으로 보인다 — 안전하게 명시적으로 부여한다(RLS 정책은
-- 이미 적용돼 있으므로, 이 GRANT는 "테이블에 접근은 가능하게" 하는 것뿐이고 실제
-- 행 단위 접근 제어는 여전히 기존 RLS 정책이 그대로 담당한다).
--
-- 여러 번 실행해도 안전(GRANT는 멱등적).
-- ============================================================

grant select, insert, update, delete on
    membership_product_grades,
    membership_product_members,
    coupons,
    coupon_products,
    member_coupons
to authenticated;

grant select, insert, update, delete on
    membership_product_grades,
    membership_product_members,
    coupons,
    coupon_products,
    member_coupons
to service_role;

-- anon(비로그인)은 이 5개 테이블에 접근할 이유가 전혀 없다(전부 로그인 후 매니저/
-- 회원 세션 전용 데이터) — 의도적으로 grant하지 않는다.

-- ============================================================
-- 확인(read-only)
-- ============================================================
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
-- where table_name in ('membership_product_grades','membership_product_members',
--                       'coupons','coupon_products','member_coupons')
-- order by table_name, grantee;
