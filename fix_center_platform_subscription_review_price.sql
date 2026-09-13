-- ============================================================
-- 토스페이먼츠 빌링(자동결제) 계약 심사용 — "기본 플랜" 가격을 심사 제출값(월 39,000원)으로 설정
-- + 테스트성 junk 플랜("ㄹ", 222,222원) 정리
--
-- 배경: add_center_platform_subscription.sql이 만든 "기본 플랜"은 사업 가격 결정 전이라
-- monthly_price=0("가격 미정")으로 seed됐다. 토스 담당자가 받은 계약심사 정보에 명시된
-- 실제 심사용 상품("모하빗 센터 이용권", 월 39,000원, 신용카드 정기결제, 1회 결제당
-- 1개월 제공·매월 자동 갱신)과 일치시키기 위해 이 값을 갱신한다.
--
-- [2026-09-14 추가 확인] 라이브 조회 결과 subscription_plans에 "기본 플랜"(id
-- 9cd9f548-..., is_default=true) 외에 이름/가격이 명백히 테스트 데이터인 "ㄹ"(222,222원,
-- is_default=false, is_active=true)행이 하나 더 있다. is_default가 아니라 신규 센터
-- 배정에는 전혀 관여하지 않지만(add_subscription_plan_limits.sql의 트리거가 is_default만
-- 봄), is_active=true라 매니저 화면의 "플랜 변경" 드롭다운에는 그대로 노출된다 — 토스
-- 심사관이 화면을 살펴보다 이 정체불명의 플랜을 보게 될 위험이 있어 함께 정리한다.
-- **DELETE가 아니라 is_active=false로 비활성화만 한다**(CLAUDE.md 규칙 3 — 기존 데이터
-- 삭제는 사용자 승인 없이 하지 않음; is_active=false는 새 UPDATE라 되돌리기도 쉽다).
-- 이 행을 참조하는 center_subscriptions.plan_id가 실제로 있는지는 아래 실행 후 확인
-- 쿼리로 반드시 확인할 것 — 있다면(현재 라이브 조회 기준 없음, 687개 센터 전부
-- "기본 플랜" 참조) 비활성화 전에 그 센터들의 플랜부터 별도로 정리해야 한다.
--
-- 이 파일은 새 테이블/RLS 변경이 아니라 기존 subscription_plans 행 값만 바꾸는 단순
-- UPDATE 2건이다(CLAUDE.md 규칙 4의 "새 SQL migration 파일" 관례를 그대로 따름 — 변경
-- 이력을 남기고 기존 add_center_platform_subscription.sql 원문은 보존).
--
-- ⚠ 가격은 사업 결정 사항이라 사용자 승인 후에만 Supabase SQL Editor(또는
-- `supabase db query --linked -f`)로 실행할 것 — 이 배치 작업이 자동으로 실행하지 않았다.
-- (대안: /admin/subscription-plans 화면에서 운영자가 직접 같은 값을 입력해도 동일한
-- 효과 — 이 SQL은 그 화면을 쓰지 않고 한 번에 처리하고 싶을 때용.)
--
-- 여러 번 실행해도 안전(이미 원하는 값이면 조건에 안 걸려 0행 갱신).
-- ============================================================

BEGIN;

update subscription_plans
set name = '모하빗 센터 이용권',
    monthly_price = 39000,
    description = '센터 운영자용 모하빗 플랫폼 월 이용권 — 회원/수업/예약/수강권 관리 기능 전체 제공'
where is_active
  and monthly_price = 0
  and name = '기본 플랜';

-- 테스트성 junk 플랜 비활성화(삭제 아님) — 어떤 센터도 이 플랜을 실제로 쓰고 있지
-- 않을 때만 안전하게 걸리도록 NOT EXISTS로 방어.
update subscription_plans sp
set is_active = false
where sp.name = 'ㄹ'
  and sp.monthly_price = 222222
  and not exists (
      select 1 from center_subscriptions cs where cs.plan_id = sp.id
  );

COMMIT;

-- 실행 후 확인:
--   select name, monthly_price, is_active, is_default, description from subscription_plans order by created_at;
-- 기대 결과:
--   모하빗 센터 이용권 | 39000  | true  | true  | 센터 운영자용 모하빗 플랫폼 월 이용권 ...
--   ㄹ                  | 222222 | false | false | ㅇㅇㄹㄴㄹ
--
-- 만약 "ㄹ" 행이 여전히 is_active=true로 남아있다면(=위 UPDATE가 NOT EXISTS 조건에
-- 걸려 0행 갱신됐다는 뜻), 아래로 실제 참조 센터가 있는지 먼저 확인하고 별도로 처리할 것:
--   select cs.center_id, c.name from center_subscriptions cs
--   join centers c on c.id = cs.center_id
--   join subscription_plans sp on sp.id = cs.plan_id
--   where sp.name = 'ㄹ';
