-- ============================================================
-- 1:1 문의 (회원 ↔ 센터 채팅)
--
-- 하는 일:
--   1) inquiry_threads : 회원-센터 문의방 (1:1)
--   2) inquiry_messages: 메시지 (글 + 사진)
--   3) 회원이 문의 보내면 매니저에게 알림, 매니저가 답하면 회원에게 알림
--   4) 실시간은 inquiry_messages Realtime 구독으로 처리
--
-- ⚠ add_notifications.sql 을 먼저 실행하세요 (push_notification 함수 필요).
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- 문의방 (회원 account + 센터 조합당 1개)
-- ------------------------------------------------------------
create table if not exists inquiry_threads (
    id                uuid primary key default gen_random_uuid(),
    center_id         uuid not null references centers(id) on delete cascade,
    member_account_id uuid not null references accounts(id) on delete cascade,
    last_message      text,
    last_message_at   timestamptz,
    member_unread     int not null default 0,   -- 회원이 안 읽은 수
    manager_unread    int not null default 0,   -- 매니저가 안 읽은 수
    created_at        timestamptz not null default now(),
    unique (center_id, member_account_id)
);

create index if not exists idx_threads_member on inquiry_threads(member_account_id, last_message_at desc);
create index if not exists idx_threads_center on inquiry_threads(center_id, last_message_at desc);

alter table inquiry_threads enable row level security;

-- 회원: 본인 문의방
drop policy if exists "문의방 회원 조회" on inquiry_threads;
create policy "문의방 회원 조회"
    on inquiry_threads for select
    using (member_account_id = my_account_id());

-- 매니저: 자기 센터 문의방
drop policy if exists "문의방 매니저 조회" on inquiry_threads;
create policy "문의방 매니저 조회"
    on inquiry_threads for select
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());


-- ------------------------------------------------------------
-- 메시지
--   sender_role: 'member' | 'manager'
-- ------------------------------------------------------------
create table if not exists inquiry_messages (
    id                uuid primary key default gen_random_uuid(),
    thread_id         uuid not null references inquiry_threads(id) on delete cascade,
    sender_account_id uuid not null references accounts(id),
    sender_role       text not null check (sender_role in ('member', 'manager')),
    body              text not null default '',
    photos            text[],
    created_at        timestamptz not null default now()
);

create index if not exists idx_messages_thread on inquiry_messages(thread_id, created_at);

alter table inquiry_messages enable row level security;

-- 조회: 문의방 볼 수 있으면 메시지도 볼 수 있음
drop policy if exists "문의메시지 조회" on inquiry_messages;
create policy "문의메시지 조회"
    on inquiry_messages for select
    using (
        thread_id in (
            select id from inquiry_threads
             where member_account_id = my_account_id()
                or center_id in (select my_managed_center_ids())
                or is_platform_admin()
        )
    );

-- 실시간 구독
alter publication supabase_realtime add table inquiry_messages;


-- ------------------------------------------------------------
-- 문의방 열기/찾기 (회원이 센터 선택 시)
--   없으면 만들고 있으면 반환
-- ------------------------------------------------------------
create or replace function open_inquiry_thread(p_center_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account uuid := my_account_id();
    v_id uuid;
begin
    if v_account is null then
        raise exception '로그인이 필요해요';
    end if;

    select id into v_id from inquiry_threads
     where center_id = p_center_id and member_account_id = v_account;

    if v_id is null then
        insert into inquiry_threads(center_id, member_account_id)
        values (p_center_id, v_account)
        returning id into v_id;
    end if;

    return v_id;
end;
$$;


-- ------------------------------------------------------------
-- 메시지 전송 (회원/매니저 공용)
--   - 권한 확인 → 메시지 저장 → 방 요약/미읽음 갱신 → 상대에게 알림
-- ------------------------------------------------------------
create or replace function send_inquiry_message(
    p_thread_id uuid, p_body text, p_photos text[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account uuid := my_account_id();
    v_center uuid;
    v_member uuid;
    v_role text;
    v_id uuid;
    v_preview text;
    v_center_name text;
    m record;
begin
    select center_id, member_account_id into v_center, v_member
      from inquiry_threads where id = p_thread_id;
    if v_center is null then
        raise exception '문의방을 찾을 수 없어요';
    end if;

    -- 발신자 역할 판별
    if v_account = v_member then
        v_role := 'member';
    elsif v_center in (select my_managed_center_ids()) or is_platform_admin() then
        v_role := 'manager';
    else
        raise exception '이 문의방에 메시지를 보낼 권한이 없어요';
    end if;

    insert into inquiry_messages(thread_id, sender_account_id, sender_role, body, photos)
    values (p_thread_id, v_account, v_role, coalesce(p_body, ''), p_photos)
    returning id into v_id;

    -- 미리보기 텍스트
    v_preview := nullif(trim(coalesce(p_body, '')), '');
    if v_preview is null then
        v_preview := '📷 사진';
    end if;

    select name into v_center_name from centers where id = v_center;

    -- 방 요약 갱신 + 상대방 미읽음 +1
    if v_role = 'member' then
        update inquiry_threads
           set last_message = v_preview, last_message_at = now(),
               manager_unread = manager_unread + 1
         where id = p_thread_id;

        -- 매니저 전원에게 알림
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'new_inquiry', '새 1:1 문의',
                v_preview, v_center, '/manager/inquiries',
                jsonb_build_object('thread_id', p_thread_id)
            );
        end loop;
    else
        update inquiry_threads
           set last_message = v_preview, last_message_at = now(),
               member_unread = member_unread + 1
         where id = p_thread_id;

        -- 회원에게 알림
        perform push_notification(
            v_member, 'inquiry_reply',
            coalesce(v_center_name, '센터') || ' 답변',
            v_preview, v_center, '/inquiries',
            jsonb_build_object('thread_id', p_thread_id)
        );
    end if;

    return v_id;
end;
$$;


-- ------------------------------------------------------------
-- 문의방 읽음 처리 (내 쪽 미읽음 0으로)
-- ------------------------------------------------------------
create or replace function read_inquiry_thread(p_thread_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account uuid := my_account_id();
    v_center uuid;
    v_member uuid;
begin
    select center_id, member_account_id into v_center, v_member
      from inquiry_threads where id = p_thread_id;
    if v_center is null then return; end if;

    if v_account = v_member then
        update inquiry_threads set member_unread = 0 where id = p_thread_id;
    elsif v_center in (select my_managed_center_ids()) or is_platform_admin() then
        update inquiry_threads set manager_unread = 0 where id = p_thread_id;
    end if;
end;
$$;


-- ============================================================
-- 완료!
--   회원: 마이페이지 → 1:1 문의
--   매니저: 더보기 → 1:1 문의
-- ============================================================
