-- 롤백: 2026-10-22 운영 감사 로그에서 읽은 collect_unpaid_payment 정의로 복원(초과 회수 차단 제거).
-- 실행 권한은 이 파일에서 건드리지 않는다(원본 ACL 상태를 적용 직전 백업으로 확인할 것).
CREATE OR REPLACE FUNCTION public.collect_unpaid_payment(p_original_payment_id uuid, p_card_amount numeric, p_cash_amount numeric, p_transfer_amount numeric, p_point_amount numeric, p_paid_at timestamp with time zone, p_memo text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_orig       payments%rowtype;
    v_collected  numeric;
    v_new_id     uuid;
begin
    select * into v_orig from payments where id = p_original_payment_id for update;
    if not found then
        raise exception '원본 결제를 찾을 수 없어요';
    end if;
    if not (has_permission(v_orig.center_id, 'pass.payment.create') or is_platform_admin()) then
        raise exception '매출을 등록할 권한이 없어요';
    end if;
    if coalesce(v_orig.unpaid_amount, 0) <= 0 then
        raise exception '이 결제는 미수금이 없어요';
    end if;

    v_collected := coalesce(p_card_amount, 0) + coalesce(p_cash_amount, 0)
                 + coalesce(p_transfer_amount, 0) + coalesce(p_point_amount, 0);
    if v_collected <= 0 then
        raise exception '받은 금액을 입력해주세요';
    end if;

    insert into payments (
        center_id, profile_id, membership_id, sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, trainer_account_id, paid_at, memo, status,
        linked_unpaid_payment_id
    ) values (
        v_orig.center_id, v_orig.profile_id, v_orig.membership_id, 'unpaid_pay', v_orig.revenue_category,
        coalesce(p_card_amount, 0), coalesce(p_cash_amount, 0), coalesce(p_transfer_amount, 0), coalesce(p_point_amount, 0),
        v_collected, 0, v_orig.trainer_account_id, p_paid_at, p_memo, 'paid',
        p_original_payment_id
    ) returning id into v_new_id;

    update payments
    set unpaid_amount = greatest(0, coalesce(unpaid_amount, 0) - v_collected)
    where id = p_original_payment_id;

    return v_new_id;
end;
$function$
;
