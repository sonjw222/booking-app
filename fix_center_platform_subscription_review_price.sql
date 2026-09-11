-- ============================================================
-- 토스페이먼츠 빌링(자동결제) 계약 심사용 — "기본 플랜" 가격을 심사 제출값(월 39,000원)으로 설정
--
-- 배경: add_center_platform_subscription.sql이 만든 "기본 플랜"은 사업 가격 결정 전이라
-- monthly_price=0("가격 미정")으로 seed됐다. 토스 담당자가 받은 계약심사 정보에 명시된
-- 실제 심사용 상품("모하빗 센터 이용권", 월 39,000원, 신용카드 정기결제, 1회 결제당
-- 1개월 제공·매월 자동 갱신)과 일치시키기 위해 이 값을 갱신한다.
--
-- 이 파일은 새 테이블/RLS 변경이 아니라 기존 subscription_plans 행의 가격 값만 바꾸는
-- 단순 UPDATE다(CLAUDE.md 규칙 4의 "새 SQL migration 파일" 관례를 그대로 따름 — 변경
-- 이력을 남기고 기존 add_center_platform_subscription.sql 원문은 보존).
--
-- ⚠ 가격은 사업 결정 사항이라 사용자 승인 후에만 Supabase SQL Editor(또는
-- `supabase db query --linked -f`)로 실행할 것 — 이 배치 작업이 자동으로 실행하지 않았다.
--
-- 여러 번 실행해도 안전(이미 39000이면 조건에 안 걸려 0행 갱신).
-- ============================================================

BEGIN;

update subscription_plans
set name = '모하빗 센터 이용권',
    monthly_price = 39000,
    description = '센터 운영자용 모하빗 플랫폼 월 이용권 — 회원/수업/예약/수강권 관리 기능 전체 제공'
where is_active
  and monthly_price = 0
  and name = '기본 플랜';

COMMIT;

-- 실행 후 확인:
--   select name, monthly_price, description from subscription_plans where is_active;
-- 기대 결과: 모하빗 센터 이용권 | 39000 | 센터 운영자용 모하빗 플랫폼 월 이용권 ...
