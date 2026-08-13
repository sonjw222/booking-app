-- ============================================================
-- SEC-116(P2): fulfill_order()가 세분권한 대신 my_managed_center_ids()만 사용
--
-- [근본 원인] fulfill_order()의 권한 체크가
--   v_order.center_id in (select my_managed_center_ids()) or is_platform_admin()
-- 뿐이라 "그 센터의 active 매니저이기만 하면" 결제/매출 관련 세분권한
-- (pass.payment.create, "결제 등록")이 전혀 없는 스태프도 주문을 발급 처리할 수
-- 있었다. SEC-101/112/113(소속 자체의 정당성)과는 독립적인 문제 — 소속이 정당해도
-- 세분권한 모델을 우회한다.
--
-- [제품 결정, 2026-08-14 확인] pass.payment.create 권한 체크로 전환하기로 결정함
-- (schema.sql에 이미 있는 permission key 재사용, 신규 권한 추가 아님).
--
-- [이 파일이 하는 일] fulfill_order()의 권한 체크 한 줄만 교체 —
--   center_id in (select my_managed_center_ids()) or is_platform_admin()
--   → has_permission(center_id, 'pass.payment.create') or is_platform_admin()
-- has_permission()은 내부적으로 "그 center_id의 active 매니저인지"를 이미 포함해서
-- 확인하므로(reservation_functions.sql의 has_permission 정의: mc.center_id = p_center_id
-- and mc.status='active' 조건), my_managed_center_ids() 체크를 완전히 대체한다 —
-- 두 조건을 AND로 겹칠 필요 없음. 오너는 has_permission()에서 is_owner로 항상 true라
-- 기존과 동일하게 계속 동작한다. 그 외 발급/매출기록 로직은 완전히 동일(변경 없음).
--
-- [auto_book_membership()과의 일관성 재검토 — 필요 없음, 확인함] fulfill_order()는
-- 내부에서 auto_book_membership(v_membership_id)를 호출하는데, 그 함수 자신의 권한
-- 체크는 my_managed_center_ids()를 그대로 쓴다(SEC-114 결정 유지, 이 파일에서 건드리지
-- 않음). has_permission(center_id, 'pass.payment.create')를 통과한 caller는 정의상
-- 이미 그 center_id의 active 매니저이므로(위 이유), auto_book_membership()의 더
-- 느슨한 my_managed_center_ids() 체크도 자동으로 통과한다 — 바깥쪽 체크를 좁혀도
-- 안쪽 체크가 막힐 일이 없다(안쪽이 바깥쪽보다 항상 느슨함). 그래서 auto_book_membership()은
-- 이 배치에서 변경할 필요가 없다.
--
-- [confirm_test_payment()는 이 배치에서 다루지 않음] 그 함수는 회원 본인 소유 확인
-- (profile_id in my_profile_ids())이지 매니저 권한 체크가 아니라 SEC-116과 무관.
--
-- [영향받는 기존 데이터] 없음(함수 재정의만, 데이터 변경 없음).
-- [위험도] 낮음 — 오너는 영향 없음(is_owner로 항상 통과). 결제 등록 권한이 없는
-- 일반 스태프만 새로 차단된다(의도된 동작 변경, 제품 결정에 따름).
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace function fulfill_order(p_order_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_order      record;
    v_product    record;
    v_membership_id uuid;
    v_count      int;
    v_kind       text;
    v_expires    date;
begin
    -- 주문 조회 + 잠금
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    -- [SEC-116] 권한: 이 센터에서 결제 등록 권한(pass.payment.create)이 있는 매니저/오너만.
    -- has_permission()이 "그 center_id의 active 매니저인지"까지 이미 포함해서 확인하므로
    -- my_managed_center_ids() 체크는 더 이상 필요 없음(위 설명 참고).
    if not (has_permission(v_order.center_id, 'pass.payment.create') or is_platform_admin()) then
        raise exception '이 주문을 처리할 권한이 없어요';
    end if;

    -- 이미 완료된 주문이면 중복 발급 방지
    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    -- [SEC-118] verified=false(레거시/직접 insert 경로)면 현재 products.price와
    -- 직접 대조한다 — 생성 시점 스냅샷이 없어 "그때 가격"을 알 수 없으므로, 지금
    -- 가격과 다르면(조작됐거나 그 사이 가격이 바뀌었거나) 매니저가 직접 확인하게 막는다.
    if not coalesce(v_order.verified, false) then
        if v_order.product_id is null or v_order.amount <> (select price from products where id = v_order.product_id) then
            raise exception '주문 금액을 확인할 수 없어요. 상품 가격과 다릅니다 — 센터에서 직접 확인해주세요.';
        end if;
    end if;

    -- 상품 정보 (횟수/종류)
    v_count := null; v_kind := 'pass';
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := v_product.total_count;
            v_kind := v_product.product_kind;
        end if;
    end if;

    -- 유효기간 기본 60일
    v_expires := (now() + interval '60 days')::date;

    -- 1) 수강권/상품 발급
    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    -- 2) 매출 기록 (결제수단별 분류 — 직접결제 포함)
    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount, direct_amount,
        total_amount, unpaid_amount, paid_at, status, memo
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id,
        'new', 'membership',
        case when v_order.pay_method in ('card','kakao','toss') then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'transfer' then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'direct' then v_order.amount else 0 end,
        v_order.amount, 0, now(), 'paid',
        '앱 주문 자동 발급'
    );

    -- 3) 센터 회원목록에 자동 등록
    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    -- 3-1) 회원이 자동예약을 선택했고 요일반 수강권이면 자동 예약
    if coalesce(v_order.auto_book, false) then
        begin
            perform auto_book_membership(v_membership_id);
        exception when others then
            null;  -- 자동예약 실패해도 발급 자체는 성공 처리
        end;
    end if;

    -- 4) 주문 완료 처리
    update orders set status = 'done', paid_at = now() where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    );
end;
$$;

COMMIT;

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select routine_name, security_type
from information_schema.routines
where routine_name = 'fulfill_order';

select pg_get_functiondef('fulfill_order(uuid)'::regprocedure);
