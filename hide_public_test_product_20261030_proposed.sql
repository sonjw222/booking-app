-- 공개 목록 테스트 상품 비공개(판매 정지) — 제안(2026-10-30), ⚠ 실행하지 않았다. 별도 승인 후 SQL Editor 에서 실행.
-- 대상: A10TION 피겨팀(8965e09c-0d2b-44c6-ab26-40a85507f8b5)의 "테스트" 100원 상품(964ffd69-1f03-4193-a8c8-d2f5d4ed8111). 이름·가격·센터가 하나라도 다르면 중단한다.
-- 변경: products.is_on_sale 만 true → false (센터 관리자 화면 "수강권·예약조건 설정 → 판매 정지"와 같은 효과). 행 삭제·가격/이름 변경·주문·수강권 변경 없음.
-- 대안(SQL 없이): 센터 소유자 계정으로 관리자 > 수강권·예약조건 설정 > 해당 상품의 "판매 정지".
-- 사전 점검: preflight_hide_public_test_product_20261030.sql / 되돌리기: 맨 아래 롤백 블록(판매 재개).
begin;
do $$
begin
  if (select count(*) from products where id = '964ffd69-1f03-4193-a8c8-d2f5d4ed8111' and center_id = '8965e09c-0d2b-44c6-ab26-40a85507f8b5' and name = '테스트' and price = 100) <> 1 then
    raise exception '대상 상품이 예상(이름 "테스트"·100원·A10TION 피겨팀)과 달라요 — 아무것도 바꾸지 않고 중단합니다';
  end if;
end $$;
update products set is_on_sale = false
 where id = '964ffd69-1f03-4193-a8c8-d2f5d4ed8111' and center_id = '8965e09c-0d2b-44c6-ab26-40a85507f8b5' and name = '테스트' and price = 100 and is_on_sale;
commit;
-- 확인(읽기 전용): is_on_sale=false, 공개 RPC 에서 이 상품 0건
select id, name, price, is_active, is_on_sale from products where id = '964ffd69-1f03-4193-a8c8-d2f5d4ed8111';
select count(*) as public_rows_for_this_product_must_be_0 from public.fetch_public_storefront_products('8965e09c-0d2b-44c6-ab26-40a85507f8b5'::uuid) f where f.id = '964ffd69-1f03-4193-a8c8-d2f5d4ed8111';
-- 롤백(판매 재개) — 필요할 때만 아래 한 문장을 따로 실행:
--   update products set is_on_sale = true where id = '964ffd69-1f03-4193-a8c8-d2f5d4ed8111' and name = '테스트' and not is_on_sale;
