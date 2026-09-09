-- ============================================================
-- 이메일 계정 ↔ 소셜 계정 명시적 연동(Account Linking)
--
-- 배경(docs/TODO.md P2-0, docs/08_Decision_Log.md DEC-004): 이메일로 가입한 사람이 나중에
-- 카카오/구글 등 다른 방식으로 로그인하면 accounts.auth_id가 auth.users.id와 1:1이고
-- accounts에 email 컬럼이 없어서 자동 매칭이 안 되고, 완전히 별개의 계정이 조용히 하나 더
-- 생긴다. 이미 이렇게 따로 생긴 두 계정(A=남을 계정, B=합쳐질 계정)을 사용자가 명시적으로
-- 확인한 뒤 실제로 병합하는 기능이다.
--
-- Supabase의 linkIdentity()는 "이미 다른 auth.users가 점유한 identity"에는 쓸 수 없어서
-- (공식 제약) 데이터 재배정을 직접 구현한다. B의 auth.users 행은 삭제하지 않는다 — 삭제하면
-- B가 재로그인할 때마다 새 계정이 또 생기는 악순환이 된다(기존 delete-account Edge Function의
-- "탈퇴=auth.users 실제 삭제" 패턴과는 반대 방향이니 혼동 주의).
--
-- 흐름: A로 로그인한 상태에서 코드 발급(create_account_link_code) → 로그아웃 → B로 로그인 →
-- B의 세션으로 코드 입력(link_accounts_by_code) → B의 데이터가 A로 재배정되고 B의 auth_id가
-- account_auth_identities에 A로 매핑됨 → 이후 B로 로그인해도 my_account_id()가 이 매핑을
-- 거쳐 A로 resolve됨.
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(create or replace, drop/create policy if exists, if not exists).
-- ============================================================

-- ------------------------------------------------------------
-- [1] 스키마: 연동 매핑 테이블, 연동 요청(코드) 테이블, accounts.merged_into
-- ------------------------------------------------------------

alter table accounts add column if not exists merged_into uuid references accounts(id);
comment on column accounts.merged_into is
    '이 계정이 다른 계정에 합쳐졌으면 그 계정의 id. null이면 정상 계정';

create table if not exists account_auth_identities (
    id          uuid primary key default gen_random_uuid(),
    account_id  uuid not null references accounts(id),     -- 남은(주) 계정
    auth_id     uuid not null unique,                        -- 합쳐진 계정이 쓰던 auth.users.id
    provider_label text,                                     -- 참고용 표시(예: "카카오")
    linked_at   timestamptz not null default now()
);
comment on table account_auth_identities is
    '병합으로 흡수된 auth.users.id → 남은 accounts.id 매핑. my_account_id()가 1차 조회에
     실패하면 이 표를 2차로 확인한다.';

create index if not exists idx_account_auth_identities_account
    on account_auth_identities(account_id);

alter table account_auth_identities enable row level security;
-- 의도적으로 anon/authenticated 정책을 하나도 안 만든다(phone_verifications와 동일 패턴) —
-- REST로는 아예 안 보이고, security definer 함수를 통해서만 접근한다.

create table if not exists account_link_requests (
    id                    uuid primary key default gen_random_uuid(),
    requester_account_id  uuid not null references accounts(id),   -- 코드를 만든 계정(A, 남을 계정)
    code                  text not null,
    status                text not null default 'pending'
                          check (status in ('pending', 'used', 'expired')),
    expires_at            timestamptz not null,
    used_at               timestamptz,
    created_at            timestamptz not null default now()
);
comment on table account_link_requests is '계정 연동 일회성 코드. 계정당 대기 중인 코드는 하나뿐';

create unique index if not exists idx_account_link_requests_one_pending
    on account_link_requests(requester_account_id) where status = 'pending';
create unique index if not exists idx_account_link_requests_pending_code
    on account_link_requests(code) where status = 'pending';

alter table account_link_requests enable row level security;
-- 여기도 REST 정책 없음 — RPC 두 개로만 접근.


-- ------------------------------------------------------------
-- [2] my_account_id() / is_platform_admin() / _is_owner_of_center() 를 연동 인지하게 재정의
-- ------------------------------------------------------------

create or replace function my_account_id()
returns uuid
language sql stable
security definer
set search_path = public
as $$
    -- security definer: 정책 안에서 이 함수를 호출해도 accounts RLS를 다시
    --   타지 않게 함 (그렇지 않으면 accounts 조회 정책 ↔ 이 함수 사이 무한 재귀)
    select coalesce(
        (select id from accounts where auth_id = auth.uid()),
        (select account_id from account_auth_identities where auth_id = auth.uid())
    );
$$;

create or replace function is_platform_admin()
returns boolean
language sql stable
security definer
set search_path = public
as $$
    -- my_account_id() 경유로 재작성 — 병합된 계정으로 로그인해도 원래(A) 계정의
    -- 플랫폼 어드민 여부를 그대로 물려받는다.
    select coalesce((select is_platform_admin from accounts where id = my_account_id()), false);
$$;

create or replace function _is_owner_of_center(p_center_id uuid)
returns boolean
language sql stable
as $$
    select exists (
        select 1
        from manager_centers mc
        join center_roles cr on cr.id = mc.role_id
        where mc.center_id = p_center_id
          and mc.account_id = my_account_id()
          and cr.is_owner
          and mc.status = 'active'
    );
$$;


-- ------------------------------------------------------------
-- [3] accounts 테이블 자체의 RLS — my_account_id()를 안 거치는 예외라 직접 OR 분기 추가
-- ------------------------------------------------------------

drop policy if exists "본인 계정 수정" on accounts;
drop policy if exists "본인 계정 삭제" on accounts;
drop policy if exists "계정 조회" on accounts;

create policy "본인 계정 수정"
    on accounts for update
    using (auth_id = auth.uid() or id in (select account_id from account_auth_identities where auth_id = auth.uid()))
    with check (auth_id = auth.uid() or id in (select account_id from account_auth_identities where auth_id = auth.uid()));

create policy "본인 계정 삭제"
    on accounts for delete
    using (auth_id = auth.uid() or id in (select account_id from account_auth_identities where auth_id = auth.uid()));

create policy "계정 조회"
    on accounts for select
    using (
        auth_id = auth.uid()
        or id in (select account_id from account_auth_identities where auth_id = auth.uid())
        -- 내 센터의 스태프 계정
        or id in (
            select mc.account_id from manager_centers mc
            where mc.center_id in (select my_managed_center_ids())
        )
        -- 내 센터 회원의 계정
        or id in (
            select p.account_id from profiles p
            join center_members cm on cm.profile_id = p.id
            where cm.center_id in (select my_managed_center_ids())
        )
        -- 스태프 등록 권한이 있으면 초대 대상 검색 가능
        or exists (
            select 1 from manager_centers mc
            join center_roles r on r.id = mc.role_id
            where mc.account_id = my_account_id()
              and mc.status = 'active'
              and (r.is_owner = true
                   or exists (select 1 from role_permissions rp
                              where rp.role_id = r.id
                                and rp.permission_key = 'facility.staff.create'))
        )
    );


-- ------------------------------------------------------------
-- [4] RPC: 연동 코드 발급 (호출자 = A, 남을 계정)
-- ------------------------------------------------------------

create or replace function create_account_link_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account_id uuid;
    v_code text;
begin
    v_account_id := my_account_id();
    if v_account_id is null then
        raise exception '로그인이 필요해요';
    end if;

    -- 이미 유효한 대기 코드가 있으면 재사용
    select code into v_code from account_link_requests
        where requester_account_id = v_account_id and status = 'pending' and expires_at > now();
    if v_code is not null then
        return v_code;
    end if;

    -- 만료된 pending 행이 남아있으면 정리(unique 인덱스가 계정당 1개 pending만 허용하므로)
    update account_link_requests set status = 'expired'
        where requester_account_id = v_account_id and status = 'pending';

    loop
        v_code := lpad((floor(random() * 100000000))::text, 8, '0');
        exit when not exists (select 1 from account_link_requests where code = v_code and status = 'pending');
    end loop;

    insert into account_link_requests (requester_account_id, code, status, expires_at)
    values (v_account_id, v_code, 'pending', now() + interval '10 minutes');

    return v_code;
end;
$$;


-- ------------------------------------------------------------
-- [5] RPC: 코드로 계정 병합 (호출자 = B, 합쳐질 계정)
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
    update native_push_tokens set account_id = v_a_id where account_id = v_b_id;
    update push_subscriptions set account_id = v_a_id where account_id = v_b_id;
    update admin_action_logs set admin_id = v_a_id where admin_id = v_b_id;

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

-- ============================================================
-- 확인
-- ============================================================
select 'account_auth_identities' as 항목, count(*)::text as 값 from account_auth_identities
union all
select 'account_link_requests', count(*)::text from account_link_requests
union all
select 'accounts.merged_into 컬럼', count(*)::text from information_schema.columns
    where table_name = 'accounts' and column_name = 'merged_into';
