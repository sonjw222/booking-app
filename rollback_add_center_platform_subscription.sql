-- add_center_platform_subscription.sql 롤백
--
-- 주의: 이 롤백은 center_subscription_charges / center_subscriptions /
-- subscription_plans 세 테이블을 전부 삭제합니다(데이터 포함). 실제 운영 DB에
-- 카드 등록·청구 이력이 이미 쌓인 뒤라면 실행 전 반드시 사용자 승인을 받고
-- 백업을 확보하세요 — 이 세 테이블은 새로 추가된 것이라 되돌려도 기존 기능에는
-- 영향이 없지만, 쌓인 구독/청구 데이터 자체는 복구할 수 없습니다.

BEGIN;

drop trigger if exists trg_create_default_center_subscription on centers;
drop function if exists create_default_center_subscription();

drop policy if exists "센터 구독 청구내역 조회" on center_subscription_charges;
drop policy if exists "센터 구독 조회" on center_subscriptions;
drop policy if exists "구독 플랜 운영자 관리" on subscription_plans;
drop policy if exists "구독 플랜 공개 조회" on subscription_plans;

drop table if exists center_subscription_charges;
drop table if exists center_subscriptions;
drop table if exists subscription_plans;

COMMIT;
