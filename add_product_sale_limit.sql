-- ============================================================
-- 수강권(상품) 판매 수량 제한 (특강 정원만큼만 판매)
--
-- 배경(사용자 요청, 2026-09-13): 특강처럼 정원이 정해진 수업의 수강권은 정원만큼만
-- 팔고 싶은데, 지금은 매니저가 예약 인원을 수시로 확인하며 수동으로 "판매정지"를
-- 눌러야 했다. products.max_quantity(선택, 비우면 무제한)를 설정해두면 그 개수만큼
-- 팔린 뒤에는 자동으로 더 팔리지 않게 하고, 회원 화면에는 "N개 남음"을 보여준다.
--
-- 설계:
--   1) products.max_quantity(nullable int) — null이면 기존과 동일(무제한 판매).
--      정원과 무관한 독립 설정 — 매니저가 특강 정원(예: 10명)에 맞춰 직접 입력한다
--      (수업-상품 1:1 강제 연결은 하지 않음 — class_allowed_products는 이미 N:M
--      "예약 가능 조건" 용도라 의미가 다름).
--   2) 판매 개수 집계: 이 상품으로 발급된 memberships 중 status <> 'refunded'인
--      행 수 = "판매됨". 환불되면 자리가 다시 생겨 재판매 가능(status = 'refunded'
--      제외 조건 하나로 자연히 처리됨).
--   3) 강제 지점: memberships INSERT 트리거 하나로 통일한다 — 이 저장소에는 수강권을
--      발급하는 경로가 최소 3곳(lib/sales.ts의 registerPayment/grantProductToMember는
--      클라이언트에서 직접 insert, fulfill_order() RPC는 회원 주문 처리 시)이라
--      각 경로에 개별로 체크를 넣으면 하나를 빠뜨릴 위험이 있다(이 저장소에서
--      "새 진입점에 기존 안전장치 빠뜨림" 패턴이 실제로 여러 번 재발했음). DB
--      트리거면 어느 경로로 insert하든 동일하게 강제되고, products 행을 FOR UPDATE로
--      잠가 동시 구매 경쟁 상태에서도 초과 판매를 막는다.
--
-- [영향받는 기존 데이터] 없음 — max_quantity는 전부 NULL(무제한)로 시작, 기존 상품
-- 판매 동작 변화 없음. 트리거는 max_quantity가 설정된 상품에만 실제로 개수를 셈.
-- [위험도] 낮음 — 컬럼/뷰 신규 추가 + INSERT 트리거 신규 추가(기존 INSERT 로직은
-- 전혀 안 건드림, 초과 시에만 예외 발생).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table products add column if not exists max_quantity int;

alter table products drop constraint if exists products_max_quantity_positive;
alter table products add constraint products_max_quantity_positive
    check (max_quantity is null or max_quantity > 0);

comment on column products.max_quantity is 'null이면 무제한 판매. 설정하면 이 개수만큼 발급된 뒤(환불 제외) 추가 발급이 트리거에서 차단됨.';

-- ------------------------------------------------------------
-- 발급(INSERT) + 재지정(UPDATE) 시 한도 체크 — 어느 진입점(직접 insert/RPC)이든 동일 적용
--
-- ⚠ 2026-09-13 QA에서 발견: 처음엔 BEFORE INSERT에만 걸었는데, 이미 존재하는(다른
-- 상품용) membership 행의 product_id를 매진된 상품으로 UPDATE하거나, 환불(refunded)
-- 상태를 다시 active로 되돌리면 INSERT가 아니라서 한도 체크를 우회했다(실제로
-- 재현 확인함). BEFORE UPDATE OF product_id, status도 함께 걸어 막는다.
-- ------------------------------------------------------------
create or replace function public.enforce_product_sale_limit()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_max  int;
    v_sold int;
begin
    if new.product_id is null then
        return new;
    end if;
    if new.status = 'refunded' then
        return new;
    end if;

    -- UPDATE인데 상품도 안 바뀌고 이미 카운트되고 있던 행(원래도 refunded가 아니었음)
    -- 이면 한도 재확인이 필요 없다 — remaining_count 차감 등 흔한 업데이트마다 매번
    -- 다시 세면, 이미 정원이 찬 상품의 기존 보유자 행을 만지는 것만으로 잘못 차단될 수
    -- 있음(자기 자신이 이미 sold 카운트에 포함돼 있으므로).
    if TG_OP = 'UPDATE'
       and new.product_id is not distinct from old.product_id
       and old.status <> 'refunded' then
        return new;
    end if;

    -- 같은 상품에 대한 동시 발급/재지정 요청을 직렬화 — 이 잠금이 없으면 두 요청이
    -- 동시에 "아직 여유 있음"으로 판정해 정원을 넘길 수 있음(경쟁 상태).
    select max_quantity into v_max from products where id = new.product_id for update;

    if v_max is null then
        return new;
    end if;

    select count(*) into v_sold from memberships
    where product_id = new.product_id and status <> 'refunded';

    if v_sold >= v_max then
        raise exception '이 상품은 판매 수량이 모두 소진됐어요';
    end if;

    return new;
end;
$function$;

drop trigger if exists trg_enforce_product_sale_limit on memberships;
create trigger trg_enforce_product_sale_limit
    before insert or update of product_id, status on memberships
    for each row execute function enforce_product_sale_limit();

-- ------------------------------------------------------------
-- 회원 화면에 보여줄 "판매된 개수" 집계 뷰 (class_reservation_counts와 동일 패턴 —
-- 개인정보 없이 개수만 노출, RLS 우회 없이 authenticated에게 SELECT만 허용)
-- ------------------------------------------------------------
create or replace view product_sale_counts as
select
    product_id,
    count(*)::int as sold_count
from memberships
where product_id is not null and status <> 'refunded'
group by product_id;

grant select on product_sale_counts to authenticated;

-- ------------------------------------------------------------
-- 확인(읽기 전용)
-- ------------------------------------------------------------
select column_name from information_schema.columns where table_name = 'products' and column_name = 'max_quantity';
select tgname from pg_trigger where tgrelid = 'memberships'::regclass and tgname = 'trg_enforce_product_sale_limit';
select viewname from pg_views where viewname = 'product_sale_counts';
