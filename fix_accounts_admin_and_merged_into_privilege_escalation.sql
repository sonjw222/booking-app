-- ============================================================
-- Security Hotfix (P0) — accounts.is_platform_admin / accounts.merged_into
-- 자가 수정으로 인한 권한 상승·계정 탈취 취약점 수정
--
-- 배경(2026-09-11, Privacy 배치 #1 SQL 안전성 감사 중 발견):
--
-- "본인 계정 수정" RLS 정책(add_account_linking.sql)은
--   using (auth_id = auth.uid() or id in (select account_id from account_auth_identities ...))
-- 처럼 "이 행이 내 계정인지"만 확인하고 어떤 컬럼이 바뀌는지는 전혀 보지 않는다. 그 결과
-- 로그인한 사용자라면 누구나 본인 accounts row에 대해:
--
--   supabase.from("accounts").update({ is_platform_admin: true }).eq("id", myAccountId)
--
-- 를 직접 호출해 스스로를 플랫폼 운영자로 만들 수 있었다(센터 승인/반려 등 /admin/* 전체
-- 권한 획득). 더 심각한 건 merged_into다 — my_account_id()(fix_my_account_id_merged_into_
-- priority.sql)가 coalesce(merged_into, id)로 계정을 resolve하고, my_managed_center_ids()/
-- is_platform_admin() 등 거의 모든 권한 판단이 그 함수를 경유하므로:
--
--   supabase.from("accounts").update({ merged_into: "<임의의 다른 account id>" }).eq("id", myAccountId)
--
-- 를 호출하면 그 이후 모든 요청이 타깃 계정으로 identity resolution되어, 타깃이 매니저면
-- 그 센터 전체를, 플랫폼 운영자면 운영자 권한을 그대로 가로챌 수 있었다(정상 흐름인
-- link_accounts_by_code()의 코드 기반 상호 동의 검증을 완전히 우회).
--
-- pg_checkout_override는 같은 위험을 먼저 인지하고 트리거로 막았는데(add_pg_checkout_
-- reviewer_override.sql), is_platform_admin/merged_into에는 그 보호가 없었다 — 이 파일이
-- 그 공백을 메운다.
--
-- ------------------------------------------------------------
-- 설계
-- ------------------------------------------------------------
--
-- [1] is_platform_admin: pg_checkout_override와 완전히 동일한 패턴(트리거로 자가 변경
--     차단, auth.uid() is null(SQL Editor/service_role 직접 실행) 또는 이미
--     is_platform_admin()인 행위자만 허용). link_accounts_by_code()의 "권한 플래그
--     합집합(OR)" 갱신도 이 조건을 그대로 통과한다 — 호출자(B)가 이미 관리자면
--     is_platform_admin() = true라 막히지 않고, B가 관리자가 아니면 그 OR 갱신은
--     애초에 이 컬럼 값을 안 바꾸므로(new = old) 트리거가 아예 실행되지 않는다.
--     (수학적으로 항상 성립 — is_platform_admin은 두 쪽 다 boolean이라 "값이 바뀌는
--     경우"는 반드시 대상 계정이 원래 false였는데 상대가 true인 경우뿐이고, 이때도
--     호출자 자신의 is_platform_admin() 값과 무관하게 트리거 조건을 통과하는지는
--     아래 실제 시나리오로 다시 검증했다: 호출자 B가 원래 admin이면 is_platform_admin()
--     =true → 통과. B가 admin이 아니고 A만 admin이면 A행의 old/new가 이미 true/true라
--     변경 없음 → 트리거 미실행. 즉 이 트리거가 link_accounts_by_code()를 깨뜨리는
--     경우는 없다.)
--
-- [2] merged_into: pg_checkout_override와 달리 "본인이 자유롭게 바꿔도 되는 값"이
--     아니라 "오직 link_accounts_by_code() RPC를 통해서만 바뀌어야 하는 값"이다.
--     이 RPC는 SECURITY DEFINER지만 auth.uid()는 세션 GUC(request.jwt.claim.sub)라
--     SECURITY DEFINER로 실행 role이 바뀌어도 auth.uid()는 여전히 실제 호출자(일반
--     사용자)를 가리킨다 — 즉 "auth.uid() is null이면 허용" 방식은 이 RPC를 통해
--     들어오는 정상 호출까지 막아버린다. 대신 트랜잭션 로컬 플래그
--     (set_config('app.allow_merged_into_change', 'true', true))를 link_accounts_by_code()
--     내부에서 실제 UPDATE 직전에만 세워서, 그 트랜잭션 안에서만 트리거를 통과시킨다.
--     is_local=true라 트랜잭션이 끝나면 자동으로 사라져 다른 요청으로 새지 않는다.
--
-- 여러 번 실행해도 안전(create or replace function, drop/create trigger if exists).
-- ============================================================


-- ------------------------------------------------------------
-- [1] is_platform_admin 보호 — pg_checkout_override와 동일 패턴
-- ------------------------------------------------------------
create or replace function enforce_accounts_is_platform_admin_admin_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_platform_admin is distinct from old.is_platform_admin then
    if auth.uid() is not null and not is_platform_admin() then
      raise exception '이 값은 운영자만 변경할 수 있어요';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accounts_is_platform_admin_admin_only on accounts;
create trigger trg_accounts_is_platform_admin_admin_only
    before update on accounts
    for each row execute function enforce_accounts_is_platform_admin_admin_only();


-- ------------------------------------------------------------
-- [2] merged_into 보호 — link_accounts_by_code() RPC를 통해서만 변경 허용
-- ------------------------------------------------------------
create or replace function enforce_accounts_merged_into_via_linking_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.merged_into is distinct from old.merged_into then
    if auth.uid() is not null
       and coalesce(current_setting('app.allow_merged_into_change', true), 'false') <> 'true' then
      raise exception 'merged_into는 계정 연동 절차(link_accounts_by_code)를 통해서만 변경할 수 있어요';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accounts_merged_into_via_linking_only on accounts;
create trigger trg_accounts_merged_into_via_linking_only
    before update on accounts
    for each row execute function enforce_accounts_merged_into_via_linking_only();


-- ------------------------------------------------------------
-- [3] link_accounts_by_code() 재정의 — merged_into UPDATE 직전에만 위 트리거를
--     통과시키는 트랜잭션 로컬 플래그를 세운다. 그 외 로직은 현재 운영 DB에 배포된
--     정의(pg_get_functiondef로 직접 확인, fix_link_accounts_by_code_native_push_
--     tokens_optional.sql이 이미 반영된 버전)와 완전히 동일 — 한 줄만 추가했다.
-- ------------------------------------------------------------
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

    -- 이번 트랜잭션 안에서만 merged_into 보호 트리거를 통과시킨다(트랜잭션 로컬,
    -- is_local=true라 커밋/롤백 시 자동으로 사라짐 — 위 [2]번 설명 참고).
    perform set_config('app.allow_merged_into_change', 'true', true);
    update accounts set merged_into = v_a_id where id = v_b_id;

    update account_link_requests set status = 'used', used_at = now() where id = v_req.id;

    return json_build_object('mergedAccountName', v_a_name);
end;
$$;


-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select tgname
from pg_trigger
where tgrelid = 'public.accounts'::regclass and not tgisinternal
order by tgname;
-- 기대 결과에 다음 4개가 모두 포함돼야 함:
--   trg_accounts_is_platform_admin_admin_only (신규)
--   trg_accounts_merged_into_via_linking_only (신규)
--   trg_accounts_pg_checkout_override_admin_only (기존, 그대로)
--   trg_accounts_phone_verified (기존, 그대로)
