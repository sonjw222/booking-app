-- ============================================================
-- P1-1: 포인트 원장 이원화 정리 — point_transactions 하나로 통합
--
-- 지금까지 완전히 분리된 두 시스템이 있었다:
--   - point_transactions: 매니저가 매출 화면에서 수동 적립/차감(lib/sales.ts).
--     잔여 포인트 = sum(amount) (schema.sql 코멘트)
--   - point_accounts(balance 컬럼)/point_logs: 후기 작성 보상 전용(add_reviews_points.sql,
--     write_review()/use_points() RPC). 회원 화면엔 둘 다 안 보였음(포인트 표시 화면 자체가
--     없었음).
-- 사용자 결정(2026-08-15): point_transactions로 통합. 후기 보상도 이제 point_transactions에
-- 기록되고, 잔액 조회는 새 RPC(my_point_balance/my_point_balances)로 sum(amount) 계산.
--
-- point_accounts/point_logs 테이블 자체는 이 migration에서 지우지 않는다(CLAUDE.md 규칙 3,
-- DROP TABLE은 별도 명시적 승인 필요) — 기존 잔액을 point_transactions로 이관만 하고
-- 레거시로 남겨둔다. 이후 정말 안 쓰는 게 확인되면 별도 승인 받고 DROP.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전(멱등).
-- ============================================================

-- 1) 기존 point_accounts 잔액을 point_transactions로 이관 (한 번만, 재실행해도 중복 안 됨)
insert into point_transactions (profile_id, center_id, amount, reason)
select pa.profile_id, pa.center_id, pa.balance, 'P1-1 레거시 포인트 이관'
from point_accounts pa
where pa.balance <> 0
  and not exists (
    select 1 from point_transactions pt
    where pt.profile_id = pa.profile_id and pt.center_id = pa.center_id
      and pt.reason = 'P1-1 레거시 포인트 이관'
  );

-- 2) write_review(): 후기 작성 적립을 point_transactions에 기록
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

    -- 포인트 적립 (point_transactions로 통일 — P1-1)
    select coalesce(review_point, 0) into v_point from centers where id = p_center_id;
    if v_point > 0 then
        insert into point_transactions (profile_id, center_id, amount, reason)
        values (p_profile_id, p_center_id, v_point, '후기 작성 적립');
    end if;

    return json_build_object('point', v_point);
end;
$$;

-- 3) use_points(): point_transactions 기준으로 잔액 확인·차감.
--    point_accounts는 profile+center당 한 행이라 그 행을 "for update"로 잠가 동시 사용을
--    막았는데, point_transactions는 순수 원장(행이 계속 쌓임)이라 잠글 단일 행이 없다 —
--    대신 profiles 행을 "for update"로 잠가 같은 회원의 동시 포인트 사용 요청을 직렬화한다
--    (짧은 트랜잭션 안에서만 잠기므로 다른 프로필 갱신과는 충돌하지 않음).
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

    perform 1 from profiles where id = p_profile_id for update;

    select coalesce(sum(amount), 0) into v_balance
    from point_transactions
    where center_id = p_center_id and profile_id = p_profile_id;

    if v_balance < p_amount then
        raise exception '포인트가 부족해요';
    end if;

    insert into point_transactions (profile_id, center_id, amount, reason)
    values (p_profile_id, p_center_id, -p_amount, '결제 시 사용');

    return json_build_object('used', p_amount);
end;
$$;

-- 4) 잔액 조회 RPC (point_accounts.balance를 직접 읽던 클라이언트 코드를 대체)
--    point_accounts/point_logs가 프로필 단위였던 것과 동일하게, 계정의 여러 프로필(가족
--    구성원 등)을 한데 합치지 않고 특정 profile_id 기준으로만 계산한다 — 소유 확인(본인
--    프로필인지)은 my_profile_ids()로 하되, 집계는 그 프로필 하나로 좁힌다.
create or replace function my_point_balance(p_center_id uuid, p_profile_id uuid)
returns bigint
language sql stable
security definer
set search_path = public
as $$
    select coalesce(sum(amount), 0)
    from point_transactions
    where center_id = p_center_id
      and profile_id = p_profile_id
      and p_profile_id in (select my_profile_ids());
$$;

create or replace function my_point_balances(p_profile_id uuid)
returns table(center_id uuid, center_name text, balance bigint)
language sql stable
security definer
set search_path = public
as $$
    select pt.center_id, c.name, sum(pt.amount) as balance
    from point_transactions pt
    join centers c on c.id = pt.center_id
    where pt.profile_id = p_profile_id
      and p_profile_id in (select my_profile_ids())
    group by pt.center_id, c.name
    having sum(pt.amount) <> 0
    order by sum(pt.amount) desc;
$$;
