-- ============================================================
-- 센터별 "카카오 알림톡 발송" 애드온 + 추가요금 구조
--
-- 배경: 지금까지는 플랫폼(사장님) 단일 알리고 계정으로 전 센터가 알림톡/SMS를 공용으로
-- 쓸 수 있었다(app/manager/alimtalk/settings 주석 참고) — 신청 여부와 무관하게 아무 센터
-- 매니저나 발송 버튼을 누르면 실제로 나갔다. 알리고 건당 비용은 전부 플랫폼(사장님)이
-- 부담하는 구조라, 신청하지 않은 센터가 자유롭게 써도 비용만 플랫폼에 쌓이는 문제가 있다.
-- 이번 migration은 "카카오 알림톡을 신청하고 추가요금을 내는 센터만" 실제 발송이 되도록
-- center_subscriptions에 애드온 상태를 추가한다.
--
-- 설계 결정:
--   - 토스 자동결제가 아직 심사 전이라(add_center_platform_subscription.sql 참고) 실제
--     매월 청구는 여전히 안 된다 — 이 migration도 그 전제를 그대로 따라 "구조만" 만든다.
--     지금은 플랫폼 운영자가 센터와 오프라인으로 협의한 뒤 이 화면에서 켜주는 방식(수동).
--     토스 자동결제가 열리면 이 alimtalk_addon_price를 매월 청구 금액에 얹는 건 별도 작업.
--   - 켜고 끄는 주체는 플랫폼 운영자만(admin_set_center_alimtalk_addon) — 센터 오너가
--     스스로 즉시 켤 수 있게 하면 결제 확인 없이 플랫폼 비용(알리고 건당 요금)이 바로
--     발생하므로, 기존 플랜 변경(center_change_own_subscription_plan)과 달리 셀프서비스를
--     주지 않는다. 센터 오너 화면(app/manager/subscription)에는 현재 상태만 읽기 전용으로
--     보여준다.
--   - 이 애드온이 꺼진 센터는 알림톡뿐 아니라 SMS 대체발송도 막는다 — 둘 다 같은 알리고
--     계정으로 나가 플랫폼에 똑같이 비용이 발생하기 때문(app/manager/alimtalk/send의
--     "SMS로 나가요" 경고와 같은 이유). 실제 게이팅은 supabase/functions/send-alimtalk가
--     담당(이 SQL과 별개 배포 필요) — 여기서는 상태를 저장/변경하는 컬럼·RPC만 추가.
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(add column if not exists / create or replace function).
-- ============================================================

alter table center_subscriptions add column if not exists alimtalk_addon boolean not null default false;
alter table center_subscriptions add column if not exists alimtalk_addon_price int;

comment on column center_subscriptions.alimtalk_addon is
    '카카오 알림톡/SMS 발송 애드온 신청 여부. false면 이 센터는 send-alimtalk Edge Function이 '
    '발송을 거부한다(자동 규칙·매니저 즉시발송 모두 포함)';
comment on column center_subscriptions.alimtalk_addon_price is
    '이 센터에 적용 중인 알림톡 애드온 월 추가요금(원). 신청 이력이 있으면 해지 후에도 마지막 '
    '가격을 남겨둔다(재신청 시 참고용) — null이면 한 번도 설정된 적 없음';

-- 운영자 - 센터의 알림톡 애드온 켜기/끄기 + 가격 설정.
-- p_price를 생략(null)하면 기존에 설정된 가격을 그대로 유지한다 — 켤 때 최초 1회는
-- 가격을 반드시 같이 넘겨야 한다(admin_set_center_subscription_plan과 달리 이 기능은
-- 정가가 없어 운영자가 매번 정해야 함).
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

    select alimtalk_addon_price into v_existing_price
    from center_subscriptions where center_id = p_center_id;

    if not found then
        raise exception '이 센터의 구독 정보를 찾을 수 없어요';
    end if;

    if p_enabled and p_price is null and v_existing_price is null then
        raise exception '월 추가요금을 입력해주세요';
    end if;

    update center_subscriptions
    set alimtalk_addon = p_enabled,
        alimtalk_addon_price = coalesce(p_price, v_existing_price),
        updated_at = now()
    where center_id = p_center_id;
end;
$$;

-- GRANT/REVOKE를 따로 조정하지 않는다 — admin_set_center_subscription_plan과 동일한 패턴으로
-- 함수 기본값(PUBLIC 실행 가능)을 그대로 두고 내부 is_platform_admin() 체크가 실질적 게이트다.
