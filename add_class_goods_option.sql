-- ============================================================
-- 수업 상품 사용 옵션 + 예약 시 상품 함께 사용/차감
--
-- 하는 일:
--   1) classes 에 allow_goods 컬럼 추가 (이 수업에서 상품 사용 허용 여부)
--   2) reserve_class_with_goods 함수 추가
--      → 예약 시 회원이 고른 상품(대여 등) 잔여횟수도 1 차감
--      → 무제한 상품은 차감 안 함, 수업이 allow_goods=false면 무시
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table classes add column if not exists allow_goods boolean not null default true;

-- 이미 만들어진 수업들도 기본 ON으로 (원하면 개별 수업에서 끄면 됨)
update classes set allow_goods = true where allow_goods = false;


-- ============================================================
-- 예약 + (선택) 보유 상품 함께 사용
--   기존 reserve_class 를 확장: p_goods_membership_id 를 넘기면
--   그 상품(대여 등) 잔여횟수도 1 차감. 무제한(remaining_count is null)이면 차감 안 함.
--   수업이 allow_goods=false면 상품 사용 무시.
-- ============================================================

create or replace function reserve_class_with_goods(
    p_class_id uuid,
    p_profile_id uuid default null,
    p_goods_membership_id uuid default null
)
returns json
language plpgsql
security definer
as $$
declare
    v_result json;
    v_profile_id uuid;
    v_allow_goods boolean;
    v_goods record;
begin
    -- 1) 기존 예약 로직 그대로 수행 (수강권 차감 + 예약 생성)
    v_result := reserve_class(p_class_id, p_profile_id);

    -- 2) 상품을 함께 선택했으면 차감 처리
    if p_goods_membership_id is not null then
        -- 예약에 쓰인 프로필 확인
        if p_profile_id is not null then
            select id into v_profile_id from profiles
            where id = p_profile_id and account_id = my_account_id();
        else
            select id into v_profile_id from profiles
            where account_id = my_account_id() and is_primary = true limit 1;
        end if;

        -- 수업이 상품 사용을 허용하는지
        select allow_goods into v_allow_goods from classes where id = p_class_id;

        if v_allow_goods then
            -- 본인 상품이고 잔여 있는지 확인 후 차감
            select * into v_goods from memberships
            where id = p_goods_membership_id
              and profile_id = v_profile_id
            for update;

            if found then
                -- 무제한(null)이 아니고 잔여가 있으면 1 차감
                if v_goods.remaining_count is not null and v_goods.remaining_count > 0 then
                    update memberships set remaining_count = remaining_count - 1
                    where id = p_goods_membership_id;
                end if;
            end if;
        end if;
    end if;

    return v_result;
end;
$$;



-- ============================================================
-- 완료!
--   매니저: 수업 등록/수정 → "보유 상품 사용 허용" 토글
--   회원: 예약 버튼 → 확인창에서 상품 선택 → 예약 시 상품도 차감
-- ============================================================
