-- ============================================================
-- 마케팅 알림(플랫폼 전체 발송) 신규 기능
--
-- 배경: /settings/notifications의 "혜택·이벤트 알림" 토글은 지금까지 그 알림을 실제로
-- 만드는 기능 자체가 없어 "준비 중"이었다(토글 자체는 로컬 팝업 필터일 뿐 — 서버가 알림
-- 행을 만드는 걸 막는 게 아니라, 만들어진 알림 중 이 종류를 팝업으로 안 보여주는 것뿐).
--
-- 기존 "공지사항"(center_announcements/create_announcement)은 센터별로 그 센터 회원에게만
-- 보내는 기능이라 재사용하지 않기로 결정(사용자 확인, 2026-09-09) — 이건 플랫폼(운영자)이
-- 전체 회원에게 보내는 완전히 별개의 새 기능이다. create_announcement()의 "push_notification
-- 팬아웃" 패턴만 그대로 가져다 쓴다.
--
-- 발송 대상: accounts.is_member = true 전체(현재 86명, 배치/비동기 처리 불필요한 규모).
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(create table if not exists / create or replace function).
-- ============================================================

create table if not exists marketing_messages (
    id           uuid primary key default gen_random_uuid(),
    title        text not null,
    body         text not null,
    link         text,
    created_by   uuid not null references accounts(id),
    created_at   timestamptz not null default now(),
    target_count int not null default 0
);

comment on table marketing_messages is '운영자가 전체 회원에게 보낸 마케팅(혜택·이벤트) 알림 발송 이력';

alter table marketing_messages enable row level security;

drop policy if exists "운영자 마케팅메시지 조회" on marketing_messages;
create policy "운영자 마케팅메시지 조회"
    on marketing_messages for select
    using (is_platform_admin());

drop policy if exists "운영자 마케팅메시지 등록" on marketing_messages;
create policy "운영자 마케팅메시지 등록"
    on marketing_messages for insert
    with check (is_platform_admin());

-- insert는 아래 RPC를 통해서만 이뤄진다(등록과 동시에 발송 팬아웃까지 한 트랜잭션으로
-- 처리해야 하므로) — 위 INSERT 정책은 이 RPC가 security definer로 실행될 때의 안전장치.

create or replace function create_marketing_message_safe(p_title text, p_body text, p_link text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id    uuid;
    v_count int := 0;
    r       record;
begin
    if not is_platform_admin() then
        raise exception '운영자만 마케팅 알림을 보낼 수 있어요';
    end if;
    if coalesce(trim(p_title), '') = '' or coalesce(trim(p_body), '') = '' then
        raise exception '제목과 내용을 모두 입력해주세요';
    end if;

    insert into marketing_messages (title, body, link, created_by)
    values (p_title, p_body, p_link, my_account_id())
    returning id into v_id;

    for r in select id from accounts where is_member = true loop
        perform push_notification(
            r.id, 'marketing', p_title, p_body, null, p_link,
            jsonb_build_object('marketing_message_id', v_id)
        );
        v_count := v_count + 1;
    end loop;

    update marketing_messages set target_count = v_count where id = v_id;

    return v_id;
end;
$$;

revoke all on function create_marketing_message_safe(text, text, text) from public;
revoke all on function create_marketing_message_safe(text, text, text) from anon;
grant execute on function create_marketing_message_safe(text, text, text) to authenticated;

-- ============================================================
-- 확인
-- ============================================================
select tablename, rowsecurity from pg_tables where tablename = 'marketing_messages';
select policyname, cmd from pg_policies where tablename = 'marketing_messages' order by cmd;
select proname from pg_proc where proname = 'create_marketing_message_safe';
