-- rollback: fix_permission_reviews_announcements_rls.sql

drop policy if exists "센터후기 매니저 답변" on center_reviews;
create policy "센터후기 매니저 답변"
    on center_reviews for update
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());

drop policy if exists "센터후기 매니저 삭제" on center_reviews;
create policy "센터후기 매니저 삭제"
    on center_reviews for delete
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());

create or replace function reply_review(p_review_id uuid, p_reply text)
returns void
language plpgsql
security definer
as $$
declare
    v_center uuid;
begin
    select center_id into v_center from center_reviews where id = p_review_id;
    if v_center is null then
        raise exception '후기를 찾을 수 없어요';
    end if;
    if not (v_center in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 후기에 답변할 권한이 없어요';
    end if;

    update center_reviews
       set reply = nullif(trim(p_reply), ''),
           replied_at = case when nullif(trim(p_reply), '') is null then null else now() end
     where id = p_review_id;
end;
$$;

drop policy if exists "공지 매니저 작성" on center_announcements;
create policy "공지 매니저 작성"
    on center_announcements for insert
    with check (center_id in (select my_managed_center_ids()) or is_platform_admin());

drop policy if exists "공지 매니저 수정" on center_announcements;
create policy "공지 매니저 수정"
    on center_announcements for update
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());

drop policy if exists "공지 매니저 삭제" on center_announcements;
create policy "공지 매니저 삭제"
    on center_announcements for delete
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());

create or replace function create_announcement(
    p_center_id uuid, p_title text, p_body text,
    p_photos text[] default null, p_pinned boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
    v_center_name text;
    r record;
begin
    if not (p_center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 센터에 공지할 권한이 없어요';
    end if;

    insert into center_announcements(center_id, title, body, photos, pinned, created_by)
    values (p_center_id, p_title, p_body, p_photos, p_pinned, my_account_id())
    returning id into v_id;

    select name into v_center_name from centers where id = p_center_id;

    for r in
        select distinct pr.account_id
          from memberships m
          join profiles pr on pr.id = m.profile_id
         where m.center_id = p_center_id
        union
        select distinct pr2.account_id
          from reservations rv
          join classes c on c.id = rv.class_id
          join profiles pr2 on pr2.id = rv.profile_id
         where c.center_id = p_center_id
    loop
        perform push_notification(
            r.account_id, 'announcement',
            coalesce(v_center_name, '센터') || ' 공지',
            p_title, p_center_id, '/notifications', jsonb_build_object('announcement_id', v_id)
        );
    end loop;

    return v_id;
end;
$$;
