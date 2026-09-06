-- 미수금(외상) 회수 연결 (2026-09-06 UX 감사)
--
-- 배경: 결제 등록 시 unpaid_amount(미수금)를 기록하는 기능은 있었지만, 나중에 그 돈을
-- 실제로 받았을 때 "이게 어느 미수금을 갚는 건지" 연결할 방법이 전혀 없었다. 매출구분에
-- "미수금 결제"(unpaid_pay)라는 값은 정의만 돼 있고 실제로 만드는 코드가 없었음
-- (lib/sales.ts SALE_TYPE_LABEL). 그 결과 summarize()가 기간별 unpaid_amount를 단순
-- 합산만 해서, 나중에 돈을 받아도 원래 행의 unpaid_amount가 그대로 남아 "이번 달 미수금
-- 합계"가 실제보다 부풀려진 채 영원히 안 줄어들었다.
--
-- 새 결제 행(unpaid_pay)을 만들면서 원래 미수금이 있던 행을 참조하게 하고, 원래 행의
-- unpaid_amount를 회수한 만큼 줄인다. 기존 결제 등록(registerPayment)의 흐름은 전혀
-- 바꾸지 않는다 — 완전히 새로운 보조 경로.
alter table payments add column if not exists linked_unpaid_payment_id uuid references payments(id);

comment on column payments.linked_unpaid_payment_id is
  '미수금 회수용 결제(sale_type=unpaid_pay)가 어느 원본 결제의 미수금을 갚는 것인지 참조. null이면 일반 결제.';

-- 회수 처리를 원자적으로 — "새 결제 insert"와 "원본 unpaid_amount 차감"이 따로 실행되면
-- 둘 중 하나만 성공하는 상태가 생길 수 있다(둘 다 사용자 클릭 한 번의 결과여야 함).
create or replace function collect_unpaid_payment(
    p_original_payment_id uuid,
    p_card_amount numeric,
    p_cash_amount numeric,
    p_transfer_amount numeric,
    p_point_amount numeric,
    p_paid_at timestamptz,
    p_memo text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
$$;
