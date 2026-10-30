-- ============================================================
-- NICEPAY 카드사 심사 전용 센터·수강권 데이터 — 제안 개정본(2026-10-31) — ⚠ 실행하지 않았다. 운영 SQL Editor 실행은 별도 승인 사항.
-- seed_nicepay_review_center_20261028.sql 대비 변경: ① 이름·상품 구성을 실제 서비스 형태(운영 상품: 횟수제 수강권, 중앙값 약 5만원, 이용기간 90일)에 맞춤 ② 같은 이름 가드를 "이미 심사 센터가 있으면 중단"으로 강화 ③ 끝에 확인 쿼리 추가.
-- 운영 스키마와 읽기 전용 대조 완료(2026-10-31): 필수 컬럼은 centers.name·center_settings.center_id·products.center_id/name 뿐이고 아래 INSERT 가 모두 채운다. 상품 수 제한(max_products)은 null(무제한).
-- 센터 INSERT 시 DB 트리거가 자동으로 만드는 행(이 파일이 직접 넣지 않음): center_roles 3(스튜디오 오너/매니저/강사), center_payout_accounts 1(not_registered), center_settlement_accounts 1,
--   center_subscriptions 1(기본 플랜, status=pending_billing_setup — 기존 센터 5곳과 같은 상태, 회원 구매를 막지 않음). SQL Editor 는 JWT 가 없어 guard_center_insert 가 status/is_internal 을 덮어쓰지 않는다.
-- 이 센터는 "심사 환경"임을 소개 문구에 밝힌다. 주소·사업자번호는 임의로 만들지 않는다(null). 취소·환불은 기존 환불정책을 그대로 따른다.
-- [2026-10-30 재검토] 실제로 존재하지 않는 수업·서비스를 판매 상품처럼 보이게 하지 않도록 ① 상품명에서 "수업"을 빼고 "(심사용)"을 붙임 ② 센터 소개·상품 설명에 "심사용 거래이며 실제 수업·서비스 제공 없음"을 명시.
--   가격(15,000/60,000/110,000)·기간(30/60/90일)은 유지: 운영 활성 수강권 18종은 모두 횟수제·이용기간 90일·가격 100~320,000원(중앙값 50,000원)이라 현실적인 범위이고, 카드 승인 최소금액(1,000원) 이상이며 사전예약 0일·서비스 제공기간 ≤ 90일로 NICEPAY 기준(사전예약 ≤ 60일, 제공기간 ≤ 1년)을 충족한다.
-- 사용자 확정 필요 값: 센터 표시명, 상품명·가격·이용일수(아래 값은 제안).
-- 전제: P2·P2b 적용(운영 적용·검증 완료). 일반 회원·토스 심사관·비로그인에게는 보이지 않는다(P2 제한 정책) — 심사관 지정은 별도 SQL(assign_nicepay_reviewer_20261031_proposed.sql).
-- ============================================================
BEGIN;
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name='centers' and column_name='is_nicepay_review')
     or to_regprocedure('nicepay_review_center_allowed(uuid)') is null
     or (select count(*) from pg_policies where policyname = 'nicepay_review_isolation') < 3 then
    raise exception '먼저 add_nicepay_review_center_isolation_20261028.sql(P2)을 적용하세요(분리 없이 심사 센터를 만들면 일반 회원에게 노출됩니다)';
  end if;
  if exists (select 1 from centers where is_nicepay_review) then
    raise exception '이미 심사 센터가 있어요 — 중복 생성하지 않습니다(필요하면 먼저 심사 종료 절차 확인)';
  end if;
end $$;

with c as (
  insert into centers(name, status, is_nicepay_review, is_internal, intro, categories)
  values ('모하빗 스튜디오 (NICEPAY 카드사 심사용)', 'approved', true, false,
          'NICEPAY 카드사 심사를 위해 심사관에게만 제공되는 심사 전용 센터입니다. 일반 회원에게는 노출되지 않으며, 표시된 이용권은 결제 절차 확인을 위한 심사용 거래입니다(실제 수업·서비스 제공 없음). 이용권은 결제일부터 바로 이용 가능한 형태로 표시되고, 취소·환불은 모하빗 환불정책 페이지를 따릅니다.',
          '{}')
  returning id
), s as (insert into center_settings(center_id) select id from c returning center_id)
insert into products(center_id, name, price, product_kind, pass_type, total_count, unlimited_pass, expiry_mode, expiry_days, purchase_count_selectable, is_active, is_on_sale, visibility_type, description)
select c.id, v.name, v.price, 'pass', 'count', v.cnt, false, 'days', v.days, false, true, true, 'all', v.descr
from c, (values
  -- (이름, 가격, 횟수, 이용기간(일), 설명) — 운영 상품과 같은 횟수제 수강권 형태(이용 시작일=결제일, 사전예약 없음, 서비스 제공기간 ≤ 90일). 심사용이며 실제 수업·서비스 제공은 없음을 이름·설명에 밝힌다.
  ('1회 이용권 (심사용)',  15000,  1,  30, '1회 이용권 · 결제일부터 30일 이내 사용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준. [NICEPAY 심사용 상품 — 실제 수업·서비스 제공 없음]'),
  ('5회 이용권 (심사용)',  60000,  5,  60, '5회 이용권 · 결제일부터 60일 이내 사용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준. [NICEPAY 심사용 상품 — 실제 수업·서비스 제공 없음]'),
  ('10회 이용권 (심사용)', 110000, 10, 90, '10회 이용권 · 결제일부터 90일 이내 사용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준. [NICEPAY 심사용 상품 — 실제 수업·서비스 제공 없음]')
) as v(name, price, cnt, days, descr);
COMMIT;

-- 확인(읽기 전용): 심사 센터 1·상품 3·기본 행 자동 생성, 기존 센터 수 불변(생성 전 기록값 + 1)
select (select count(*) from centers where is_nicepay_review) as review_centers_must_be_1,
       (select count(*) from products where center_id in (select id from centers where is_nicepay_review)) as review_products_must_be_3,
       (select count(*) from center_roles where center_id in (select id from centers where is_nicepay_review)) as roles_info_3,
       (select count(*) from centers where not is_nicepay_review) as existing_centers_unchanged,
       (select count(*) from center_settings where center_id in (select id from centers where is_nicepay_review)) as settings_must_be_1;
