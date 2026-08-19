-- add_point_ledger_unification.sql 롤백
-- point_transactions에 이관/기록된 데이터는 지우지 않음(다른 정상 거래와 섞여있어
-- 선별 삭제가 안전하지 않음) — 함수 정의만 원래대로 되돌린다.

drop function if exists my_point_balance(uuid, uuid);
drop function if exists my_point_balances(uuid);

create or replace function write_review(
    p_center_id uuid,
    p_profile_id uuid,
    p_rating int,
    p_content text
)
returns json
language plpgsql
security definer
as $$
declare
    v_has_pass int;
    v_point    int;
    v_exists   int;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 프로필로만 후기를 쓸 수 있어요';
    end if;

    select count(*) into v_has_pass
    from memberships
    where profile_id = p_profile_id and center_id = p_center_id;
    if v_has_pass = 0 then
        raise exception '이 센터의 수강권을 구매한 회원만 후기를 쓸 수 있어요';
    end if;

    select count(*) into v_exists
    from reviews where center_id = p_center_id and profile_id = p_profile_id;
    if v_exists > 0 then
        raise exception '이미 이 센터에 후기를 작성했어요';
    end if;

    insert into reviews (center_id, profile_id, rating, content)
    values (p_center_id, p_profile_id, p_rating, p_content);

    select coalesce(review_point, 0) into v_point from centers where id = p_center_id;
    if v_point > 0 then
        insert into point_accounts (center_id, profile_id, balance)
        values (p_center_id, p_profile_id, v_point)
        on conflict (center_id, profile_id) do update
            set balance = point_accounts.balance + v_point,
                updated_at = now();

        insert into point_logs (center_id, profile_id, amount, reason, memo)
        values (p_center_id, p_profile_id, v_point, 'review', '후기 작성 적립');
    end if;

    return json_build_object('point', v_point);
end;
$$;

create or replace function use_points(
    p_center_id uuid,
    p_profile_id uuid,
    p_amount int
)
returns json
language plpgsql
security definer
as $$
declare
    v_balance int;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 포인트만 사용할 수 있어요';
    end if;
    if p_amount <= 0 then
        return json_build_object('used', 0);
    end if;

    select coalesce(balance, 0) into v_balance
    from point_accounts
    where center_id = p_center_id and profile_id = p_profile_id
    for update;

    if coalesce(v_balance, 0) < p_amount then
        raise exception '포인트가 부족해요';
    end if;

    update point_accounts
       set balance = balance - p_amount, updated_at = now()
     where center_id = p_center_id and profile_id = p_profile_id;

    insert into point_logs (center_id, profile_id, amount, reason, memo)
    values (p_center_id, p_profile_id, -p_amount, 'purchase', '결제 시 사용');

    return json_build_object('used', p_amount);
end;
$$;
