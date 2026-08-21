-- rollback: fix_permission_inquiries_orders.sql

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

    v_preview := left(coalesce(p_body, ''), 40);
    if v_preview = '' and p_photos is not null and array_length(p_photos, 1) > 0 then
        v_preview := '(사진)';
    end if;

    update inquiry_threads
       set last_message = v_preview,
           last_message_at = now(),
           member_unread = case when v_role = 'manager' then member_unread + 1 else member_unread end,
           manager_unread = case when v_role = 'member' then manager_unread + 1 else manager_unread end
     where id = p_thread_id;

    return v_id;
end;
$$;

drop policy if exists "주문 매니저 수정" on orders;
create policy "주문 매니저 수정"
    on orders for update
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());
