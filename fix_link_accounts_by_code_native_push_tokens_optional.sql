-- ============================================================
-- link_accounts_by_code() 수정 — native_push_tokens 테이블이 아직 라이브에 없어서 실패하던 버그
--
-- 배경: add_account_linking.sql의 link_accounts_by_code()가 native_push_tokens.account_id를
-- 무조건 UPDATE하는데, 이 테이블은 add_native_push_tokens.sql이 아직 적용 안 된 이 프로젝트
-- 라이브 DB에는 없다(docs/TODO.md P1-3c, Firebase 설정 전이라 보류 중) — 실제 브라우저
-- 검증(2026-09-09) 중 "relation "native_push_tokens" does not exist"로 재현됨.
--
-- to_regclass()로 테이블 존재를 확인한 뒤에만 동적 SQL로 실행하도록 고쳐서, 이 테이블이
-- 나중에 생겨도(add_native_push_tokens.sql 적용 시) 코드 변경 없이 그대로 동작한다.
--
-- DB 재생성 불필요. 여러 번 실행해도 안전(create or replace).
-- ============================================================

create or replace function link_accounts_by_code(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_b_id uuid;   -- 호출자(합쳐질 계정)
    v_a_id uuid;   -- 코드 발급자(남을 계정)
    v_req  record;
    v_a_name text;
begin
    v_b_id := my_account_id();
    if v_b_id is null then
        raise exception '로그인이 필요해요';
    end if;

    select * into v_req from account_link_requests
        where code = p_code and status = 'pending'
        for update;

    if v_req is null then
        raise exception '유효하지 않은 코드예요';
    end if;
    if v_req.expires_at < now() then
        update account_link_requests set status = 'expired' where id = v_req.id;
        raise exception '코드가 만료됐어요. 코드를 다시 발급해주세요';
    end if;

    v_a_id := v_req.requester_account_id;

    if v_a_id = v_b_id then
        raise exception '같은 계정끼리는 연결할 수 없어요';
    end if;
    if exists (select 1 from accounts where id = v_a_id and merged_into is not null) then
        raise exception '연동 코드를 만든 계정이 이미 다른 계정에 합쳐져 있어요. 코드를 다시 발급해주세요';
    end if;
    if exists (select 1 from accounts where id = v_b_id and merged_into is not null) then
        raise exception '이 계정은 이미 다른 계정에 합쳐져 있어요';
    end if;

    -- 급여 정보가 같은 센터에 둘 다 있으면 자동 병합하지 않고 중단(금액 데이터라 신중하게)
    if exists (
        select 1 from staff_salaries sa
        join staff_salaries sb on sa.center_id = sb.center_id
        where sa.account_id = v_a_id and sb.account_id = v_b_id
    ) then
        raise exception '두 계정에 같은 센터의 급여 정보가 각각 있어서 자동으로 합칠 수 없어요. 운영자에게 문의해주세요';
    end if;

    -- manager_centers: 겹치는 센터는 더 높은 권한(오너>낮은 sort_order)으로 A의 행을 승격시키고 B의 행은 삭제
    with overlap as (
        select ma.id as a_row_id, mb.id as b_row_id,
               coalesce(ra.is_owner, false) as a_owner, coalesce(ra.sort_order, 999999) as a_sort,
               coalesce(rb.is_owner, false) as b_owner, coalesce(rb.sort_order, 999999) as b_sort,
               mb.role_id as b_role_id
        from manager_centers ma
        join manager_centers mb on mb.center_id = ma.center_id and mb.account_id = v_b_id
        left join center_roles ra on ra.id = ma.role_id
        left join center_roles rb on rb.id = mb.role_id
        where ma.account_id = v_a_id
    )
    update manager_centers m
    set role_id = o.b_role_id, status = 'active'
    from overlap o
    where m.id = o.a_row_id
      and ((o.b_owner and not o.a_owner) or (o.b_owner = o.a_owner and o.b_sort < o.a_sort));

    delete from manager_centers mb
    using manager_centers ma
    where mb.account_id = v_b_id
      and ma.account_id = v_a_id
      and ma.center_id = mb.center_id;

    -- 남은(안 겹치는) manager_centers는 그대로 A 소유로 재배정
    update manager_centers set account_id = v_a_id where account_id = v_b_id;

    -- class_trainers: 겹치는 수업은 중복만 버림(정보 손실 없음)
    delete from class_trainers cb
    using class_trainers ca
    where cb.account_id = v_b_id and ca.account_id = v_a_id and ca.class_id = cb.class_id;
    update class_trainers set account_id = v_a_id where account_id = v_b_id;

    -- member_center_colors: A 우선, 겹치는 건 B 것 폐기(UI 취향값, 무해)
    delete from member_center_colors cb
    using member_center_colors ca
    where cb.account_id = v_b_id and ca.account_id = v_a_id and ca.center_id = cb.center_id;
    update member_center_colors set account_id = v_a_id where account_id = v_b_id;

    -- inquiry_threads: 같은 센터에 둘 다 문의방이 있으면 B의 메시지를 A 스레드로 옮기고 B 스레드 삭제
    update inquiry_messages im
    set thread_id = ta.id,
        sender_account_id = case when im.sender_account_id = v_b_id then v_a_id else im.sender_account_id end
    from inquiry_threads tb
    join inquiry_threads ta on ta.center_id = tb.center_id and ta.member_account_id = v_a_id
    where tb.member_account_id = v_b_id and im.thread_id = tb.id;

    delete from inquiry_threads tb
    where tb.member_account_id = v_b_id
      and exists (select 1 from inquiry_threads ta where ta.center_id = tb.center_id and ta.member_account_id = v_a_id);

    update inquiry_threads set member_account_id = v_a_id where member_account_id = v_b_id;

    -- profiles: B의 대표 프로필은 추가 프로필로 전환한 뒤 전부 A 소유로 재배정
    update profiles set is_primary = false where account_id = v_b_id and is_primary = true;
    update profiles set account_id = v_a_id where account_id = v_b_id;

    -- 단순 FK 재배정(충돌 가능한 unique 제약 없음)
    update memberships set trainer_account_id = v_a_id where trainer_account_id = v_b_id;
    update payments set trainer_account_id = v_a_id where trainer_account_id = v_b_id;
    update chat_messages set sender_account_id = v_a_id where sender_account_id = v_b_id;
    update chat_messages set receiver_account_id = v_a_id where receiver_account_id = v_b_id;
    update community_posts set author_account_id = v_a_id where author_account_id = v_b_id;
    update community_comments set author_account_id = v_a_id where author_account_id = v_b_id;
    update reviews set reviewer_account_id = v_a_id where reviewer_account_id = v_b_id;
    update reviews set target_account_id = v_a_id where target_account_id = v_b_id;
    update progress_records set coach_account_id = v_a_id where coach_account_id = v_b_id;
    update change_logs set actor_account_id = v_a_id where actor_account_id = v_b_id;
    update staff_schedules set account_id = v_a_id where account_id = v_b_id;
    update schedule_memos set author_account_id = v_a_id where author_account_id = v_b_id;
    update messages set sender_account_id = v_a_id where sender_account_id = v_b_id;
    update notifications set recipient_account_id = v_a_id where recipient_account_id = v_b_id;
    update center_announcements set created_by = v_a_id where created_by = v_b_id;
    update push_subscriptions set account_id = v_a_id where account_id = v_b_id;
    update admin_action_logs set admin_id = v_a_id where admin_id = v_b_id;

    -- native_push_tokens는 add_native_push_tokens.sql 적용 전엔 존재하지 않을 수 있음(Firebase
    -- 설정 대기 중, docs/TODO.md P1-3c) — 나중에 생겨도 코드 변경 없이 그대로 동작하게 존재
    -- 여부를 확인하고 실행한다.
    if to_regclass('public.native_push_tokens') is not null then
        execute 'update native_push_tokens set account_id = $1 where account_id = $2' using v_a_id, v_b_id;
    end if;

    -- 권한 플래그는 능력의 합집합(OR) — 병합 후 권한이 사라지면 안 됨
    select name into v_a_name from accounts where id = v_a_id;
    update accounts a
    set is_member = a.is_member or b.is_member,
        is_manager = a.is_manager or b.is_manager,
        is_platform_admin = a.is_platform_admin or b.is_platform_admin
    from accounts b
    where a.id = v_a_id and b.id = v_b_id;

    -- B의 auth_id를 A로 매핑하고 B를 병합됨으로 표시(auth.users 행 자체는 지우지 않음)
    insert into account_auth_identities (account_id, auth_id)
    select v_a_id, auth.uid()
    where not exists (select 1 from account_auth_identities where auth_id = auth.uid());

    update accounts set merged_into = v_a_id where id = v_b_id;

    update account_link_requests set status = 'used', used_at = now() where id = v_req.id;

    return json_build_object('mergedAccountName', v_a_name);
end;
$$;
