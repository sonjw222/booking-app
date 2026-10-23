-- 격리 DB 보정(테스트 전용). 저장소의 fulfill_order(fix_order_issuance_and_auto_booking.sql)는 orders.verified 를 읽지만 저장소 어떤 마이그레이션도
-- 이 컬럼을 만들지 않는다(운영에는 있는 것으로 감사에서 발급이 정상 동작했음 → 기록되지 않은 운영 마이그레이션으로 추정). 격리 DB 에서만 같은 모양으로 추가한다.
alter table orders add column if not exists verified boolean not null default false;
