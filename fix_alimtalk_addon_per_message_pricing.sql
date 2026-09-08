-- ============================================================
-- 알림톡 애드온 가격을 "월 정액"이 아니라 "건당 요금"으로 정정
--
-- 배경: add_center_alimtalk_addon_billing.sql에서 alimtalk_addon_price를 "월 추가요금"으로
-- 설계했는데, 실제 알리고/카카오 과금은 건당(발송 1건마다) 부과된다(notification_logs.cost
-- 주석 "알림톡 건당 단가"도 이미 건당 기준) — 개발서버 QA 중 사장님이 "월 요금이라는게
-- 좀 애매하다, 알림톡은 건당요금이니까 다시 정해야 한다"고 지적해서 정정한다.
--
-- 컬럼명을 alimtalk_addon_price → alimtalk_addon_unit_price로 바꿔 의미를 명확히 한다
-- (아직 실제 자동 청구가 없는 참고용 값이라는 점은 그대로 — 토스 자동결제가 열리면 이
-- 건당 가격 × 그 달 발송건수로 청구하는 로직은 별도 작업).
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(컬럼이 이미 이름 바뀐 상태면 조건절이 건너뜀).
-- ============================================================

do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_name = 'center_subscriptions' and column_name = 'alimtalk_addon_price'
    ) and not exists (
        select 1 from information_schema.columns
        where table_name = 'center_subscriptions' and column_name = 'alimtalk_addon_unit_price'
    ) then
        alter table center_subscriptions rename column alimtalk_addon_price to alimtalk_addon_unit_price;
    end if;
end $$;

comment on column center_subscriptions.alimtalk_addon_unit_price is
    '이 센터에 적용 중인 알림톡 애드온 건당 요금(원, 발송 1건마다). 신청 이력이 있으면 해지 후에도 '
    '마지막 가격을 남겨둔다(재신청 시 참고용) — null이면 한 번도 설정된 적 없음. 실제 매월 청구는 '
    '토스 자동결제 심사 전이라 아직 자동화되지 않음(사장님이 이 값 × 발송건수로 수동 청구)';

create or replace function admin_set_center_alimtalk_addon(p_center_id uuid, p_enabled boolean, p_price int default null)
returns void
language plpgsql
security definer
as $$
declare
    v_existing_price int;
begin
    if not is_platform_admin() then
        raise exception '플랫폼 운영자만 센터의 알림톡 애드온을 설정할 수 있어요';
    end if;

    select alimtalk_addon_unit_price into v_existing_price
    from center_subscriptions where center_id = p_center_id;

    if not found then
        raise exception '이 센터의 구독 정보를 찾을 수 없어요';
    end if;

    if p_enabled and p_price is null and v_existing_price is null then
        raise exception '건당 요금을 입력해주세요';
    end if;

    update center_subscriptions
    set alimtalk_addon = p_enabled,
        alimtalk_addon_unit_price = coalesce(p_price, v_existing_price),
        updated_at = now()
    where center_id = p_center_id;
end;
$$;
