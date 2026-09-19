-- Review and run against the development database before production.
-- No changes to existing member-visible thread/message policies or payment logic.
begin;
create table if not exists public.inquiry_workflows (
  thread_id uuid primary key references public.inquiry_threads(id) on delete cascade,
  status text not null default 'open' check (status in ('open','in_progress','resolved')),
  assignee_account_id uuid references public.accounts(id) on delete set null,
  version integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.accounts(id) on delete set null
);
create table if not exists public.inquiry_internal_notes (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.inquiry_threads(id) on delete cascade,
  author_account_id uuid not null references public.accounts(id),
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists inquiry_internal_notes_thread on public.inquiry_internal_notes(thread_id,created_at desc);
alter table public.inquiry_workflows enable row level security;
alter table public.inquiry_internal_notes enable row level security;
-- RPC-only access, including read. Never expose internal notes via inquiry_threads.
revoke all on public.inquiry_workflows, public.inquiry_internal_notes from public, anon, authenticated;

create or replace function public.get_inquiry_workflow(p_thread_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_center uuid; v_member uuid; v_result jsonb;
begin
  select center_id, member_account_id into v_center, v_member from inquiry_threads where id=p_thread_id;
  if my_account_id() is null or v_center is null or not (has_permission(v_center,'board.inquiry.view') or is_platform_admin()) then
    raise exception '문의 관리 정보를 볼 권한이 없습니다' using errcode='42501';
  end if;
  select jsonb_build_object('status',status,'assigneeId',assignee_account_id,'version',version,'updatedAt',updated_at)
    into v_result from inquiry_workflows where thread_id=p_thread_id;
  v_result := coalesce(v_result,jsonb_build_object('status','open','assigneeId',null,'version',0));
  return v_result || jsonb_build_object(
    'staff',coalesce((select jsonb_agg(jsonb_build_object('id',mc.account_id,'name',a.name) order by a.name)
      from manager_centers mc join accounts a on a.id=mc.account_id where mc.center_id=v_center and mc.status='active'),'[]'::jsonb),
    'notes',coalesce((select jsonb_agg(n.item order by n.created_at desc) from
      (select jsonb_build_object('id',n.id,'body',n.body,'author',a.name,'createdAt',n.created_at) item,n.created_at
       from inquiry_internal_notes n join accounts a on a.id=n.author_account_id where n.thread_id=p_thread_id order by n.created_at desc limit 50) n),'[]'::jsonb),
    'members',case when has_permission(v_center,'customer.member.view') then coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name))
       from profiles p join center_members cm on cm.profile_id=p.id and cm.center_id=v_center where p.account_id=v_member and p.deleted_at is null),'[]'::jsonb) else '[]'::jsonb end
  );
end $$;

create or replace function public.save_inquiry_workflow(p_thread_id uuid,p_status text,p_assignee_id uuid,p_version integer,p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_center uuid; v_version integer; v_account uuid := my_account_id();
begin
  select center_id into v_center from inquiry_threads where id=p_thread_id;
  if v_account is null or v_center is null or not ((has_permission(v_center,'board.inquiry.view') and has_permission(v_center,'board.inquiry.comment')) or is_platform_admin()) then
    raise exception '문의 관리 정보를 수정할 권한이 없습니다' using errcode='42501';
  end if;
  if p_status is null or p_status not in ('open','in_progress','resolved') then raise exception '올바른 처리상태를 선택해주세요'; end if;
  if p_assignee_id is not null and not exists(select 1 from manager_centers where center_id=v_center and account_id=p_assignee_id and status='active') then
    raise exception '이 센터의 활성 스태프만 담당자로 지정할 수 있습니다';
  end if;
  if length(coalesce(p_note,''))>4000 then raise exception '내부 메모는 4000자 이내로 입력해주세요'; end if;
  insert into inquiry_workflows(thread_id) values(p_thread_id) on conflict do nothing;
  select version into v_version from inquiry_workflows where thread_id=p_thread_id for update;
  if p_version is null or v_version<>p_version then raise exception '다른 사용자가 변경했습니다. 새로고침 후 다시 확인해주세요' using errcode='40001'; end if;
  update inquiry_workflows set status=p_status,assignee_account_id=p_assignee_id,version=version+1,updated_at=now(),updated_by=v_account where thread_id=p_thread_id;
  if length(btrim(coalesce(p_note,'')))>0 then
    insert into inquiry_internal_notes(thread_id,author_account_id,body) values(p_thread_id,v_account,btrim(p_note));
  end if;
  return get_inquiry_workflow(p_thread_id);
end $$;

-- A new member reply reopens resolved work without losing the assignee/notes.
create or replace function public.reopen_inquiry_workflow()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.sender_role='member' then
    update inquiry_workflows set status='open',version=version+1,updated_at=now(),updated_by=null where thread_id=new.thread_id and status='resolved';
  end if;
  return new;
end $$;
drop trigger if exists reopen_inquiry_workflow on public.inquiry_messages;
create trigger reopen_inquiry_workflow after insert on public.inquiry_messages for each row execute function public.reopen_inquiry_workflow();
revoke all on function public.get_inquiry_workflow(uuid),public.save_inquiry_workflow(uuid,text,uuid,integer,text),public.reopen_inquiry_workflow() from public, anon, authenticated;
grant execute on function public.get_inquiry_workflow(uuid),public.save_inquiry_workflow(uuid,text,uuid,integer,text) to authenticated;
commit;
