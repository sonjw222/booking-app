-- ============================================================
-- NICEPAY 카드사 심사 전용 센터·수강권 데이터 (2026-10-28) — 초안. 로컬 격리 DB 에서만 실행·검증했다. 운영/공유 DEV 에는 실행하지 않았다.
-- 운영 실행은 반드시 별도 승인이 필요하다(데이터 생성). 전제: add_nicepay_review_center_isolation_20261028.sql 이 먼저 적용돼 있어야 한다(그렇지 않으면 이 센터가 일반 회원에게 공개된다 — 아래 가드가 중단시킨다).
--
-- ⚠ 사용자 확정 필요 값(아래 v_* 값은 제안 placeholder):
--   · 센터 표시명, 상품 3종의 가격·이용기간, 서비스 내용 문구(실제 제공 가능한 서비스 또는 NICEPAY 가 승인한 심사용 거래만 허용)
--   · 센터 주소·사업자번호는 임의로 만들지 않는다(null). 필요하면 사업자등록증 기준으로 사용자가 채운다.
-- 이 센터는 "심사 환경"임을 이름·소개·상품 설명에 그대로 밝힌다(정상 운영 센터처럼 보이게 하지 않는다).
-- 기존 센터·상품·회원 데이터는 읽거나 바꾸지 않는다. 같은 이름의 센터가 이미 있으면 아무것도 하지 않는다(멱등).
-- 취소·환불 기준은 새로 정하지 않고 기존 환불 정책(/legal/refund)을 그대로 따른다고만 안내한다.
-- ============================================================
BEGIN;
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name='centers' and column_name='is_nicepay_review')
     or to_regprocedure('nicepay_review_center_allowed(uuid)') is null then
    raise exception '먼저 add_nicepay_review_center_isolation_20261028.sql 을 적용하세요(분리 없이 심사 센터를 만들면 일반 회원에게 노출됩니다)';
  end if;
end $$;

with c as (
  insert into centers(name, status, is_nicepay_review, is_internal, intro, categories)
  select '[심사 전용] MWHABIT NICEPAY 카드사 심사 환경', 'approved', true, false,
         'NICEPAY 카드사 심사를 위해 심사관에게만 제공되는 심사 전용 센터입니다. 일반 회원에게는 노출되지 않으며, 표시된 상품은 심사용 거래입니다. 취소·환불은 모하빗 환불 정책(환불정책 페이지)을 따릅니다.',
         '{}'
  where not exists (select 1 from centers where is_nicepay_review and name like '[심사 전용]%')
  returning id
), s as (insert into center_settings(center_id) select id from c returning center_id)
insert into products(center_id, name, price, product_kind, pass_type, total_count, unlimited_pass, expiry_mode, expiry_days, purchase_count_selectable, is_active, is_on_sale, visibility_type, description)
select c.id, v.name, v.price, 'pass', v.pt, v.cnt, v.unl, 'days', v.days, false, true, true, 'all', v.descr
from c, (values
  -- (이름, 가격 ⚠확정 필요, 유형, 횟수, 무제한, 이용기간(일), 설명)
  ('[심사용] 1회 수업 이용권',  1000, 'count',  1, false,  7, 'NICEPAY 심사용 상품 · 1회 수업 이용. 결제일부터 7일간 이용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준.'),
  ('[심사용] 4주 수업 이용권',  4000, 'period', null, true, 28, 'NICEPAY 심사용 상품 · 4주(28일) 기간제 이용. 결제일부터 28일간 이용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준.'),
  ('[심사용] 3개월 수업 이용권', 10000, 'period', null, true, 90, 'NICEPAY 심사용 상품 · 3개월(90일) 기간제 이용. 결제일부터 90일간 이용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준.')
) as v(name, price, pt, cnt, unl, days, descr);
COMMIT;
