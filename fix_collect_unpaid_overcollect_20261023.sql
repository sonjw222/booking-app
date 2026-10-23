-- F18: 미수금 초과 회수 차단 (2026-10-23) — 후속 SQL, 운영 직접 적용 금지(Codex 검토·적용 대상)
--
-- 결함: collect_unpaid_payment 가 회수 금액을 현재 미수 잔액과 비교하지 않아, 원미수 1000원에 300원 회수(잔액 700) 뒤 701원을
--      받아도 성공하고 unpaid_amount 만 greatest(0, …)로 0 처리돼 수금 합이 1001원이 됐다(QA 로그 extra-unpaid-overcollect-1022.json, 실제 돈 이동 없음).
-- 수정: 이미 원본 행을 `for update` 로 잠근 뒤(동시 요청은 순서대로 최신 잔액을 본다) 입력을 검증한다.
--   · 네 금액 모두 NULL 은 0 으로 보되, 음수·소수(원 단위 정수만; payments.*_amount 는 int)는 거절 — 조용한 반올림 방지
--   · 합계가 0 이하이면 거절(기존 메시지 유지)
--   · 합계가 현재 미수 잔액을 넘으면 거절(잔액 안에서 일부 회수·정확한 완납은 그대로 허용)
--   · 원본이 회수/환불 행이면 거절
--   모든 검증은 insert/update 앞에서 일어나 실패 시 어떤 행도 바뀌지 않는다. 시그니처·반환값·권한 판정(pass.payment.create)은 그대로라 구버전 앱과 호환.
-- 멱등성: 같은 요청을 재시도해도 잔액을 넘는 순간 거절된다(완납 후 재요청은 '미수금이 없어요'). 별도 멱등 키는 추가하지 않는다 —
--   같은 금액의 정상 부분 회수 두 번은 합법 거래로 구분할 수 없고 막으면 안 되기 때문(정책 결정 항목).
-- 실행 권한: public/anon 실행 권한을 걷어내고 authenticated 만 둔다(함수 안의 has_permission 이 최종 판정이며 익명은 어차피 거절됐다).

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
    v_amt        numeric;
begin
    select * into v_orig from payments where id = p_original_payment_id for update;
    if not found then
        raise exception '원본 결제를 찾을 수 없어요';
    end if;
    if not (has_permission(v_orig.center_id, 'pass.payment.create') or is_platform_admin()) then
        raise exception '매출을 등록할 권한이 없어요';
    end if;
    if v_orig.sale_type in ('unpaid_pay', 'refund') then
        raise exception '이 결제는 미수금 회수 대상이 아니에요';
    end if;
    if coalesce(v_orig.unpaid_amount, 0) <= 0 then
        raise exception '이 결제는 미수금이 없어요';
    end if;

    foreach v_amt in array array[p_card_amount, p_cash_amount, p_transfer_amount, p_point_amount] loop
        if v_amt is not null and (v_amt < 0 or v_amt <> trunc(v_amt)) then
            raise exception '받은 금액은 0 이상의 원 단위 정수로 입력해주세요';
        end if;
    end loop;

    v_collected := coalesce(p_card_amount, 0) + coalesce(p_cash_amount, 0)
                 + coalesce(p_transfer_amount, 0) + coalesce(p_point_amount, 0);
    if v_collected <= 0 then
        raise exception '받은 금액을 입력해주세요';
    end if;
    if v_collected > v_orig.unpaid_amount then
        raise exception '받은 금액(%원)이 남은 미수금(%원)보다 커요', v_collected::bigint, v_orig.unpaid_amount;
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
    set unpaid_amount = unpaid_amount - v_collected::int
    where id = p_original_payment_id;

    return v_new_id;
end;
$$;

revoke execute on function collect_unpaid_payment(uuid, numeric, numeric, numeric, numeric, timestamptz, text) from public, anon;
grant execute on function collect_unpaid_payment(uuid, numeric, numeric, numeric, numeric, timestamptz, text) to authenticated;
