-- DRAFT: additive RPC, no production execution. Enable app flag only after approved SQL and staging verification.
begin;

create or replace function public.admin_list_centers_page(
    p_status text, p_keyword text default '', p_limit integer default 30,
    p_before_created_at timestamptz default null, p_before_id uuid default null
)
returns table (
    id                   uuid,
    name                 text,
    address              text,
    phone                text,
    business_number      text,
    business_license_url text,
    status               text,
    reject_reason        text,
    created_at           timestamptz,
    owner_name           text,
    owner_phone          text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if public.is_platform_admin() is not true then   -- NULL(계정 없음/함수가 NULL 반환)도 거부: `not NULL`은 NULL이라 통과해 버리므로 IS NOT TRUE로 검사
        raise exception 'forbidden' using errcode = '42501';
    end if;
    if p_status is null or p_status not in ('pending', 'approved', 'rejected') then
        raise exception 'invalid status' using errcode = '22023';
    end if;

    if p_limit is null or p_limit < 1 or p_limit > 100
       or p_keyword is null or length(p_keyword) > 200
       or (p_before_created_at is null) <> (p_before_id is null) then
        raise exception 'invalid pagination input' using errcode = '22023';
    end if;

    return query
    select c.id, c.name, c.address, c.phone, c.business_number, c.business_license_url,
           c.status, c.reject_reason, c.created_at, o.name, o.phone
    from public.centers c
    left join lateral (
        select a.name, a.phone
        from public.manager_centers mc
        join public.accounts a on a.id = mc.account_id
        where mc.center_id = c.id
        order by mc.created_at asc, mc.id asc
        limit 1
    ) o on true
    where c.status = p_status
      and (p_before_created_at is null or (c.created_at, c.id) < (p_before_created_at, p_before_id))
      and (
        btrim(p_keyword) = ''
        or strpos(lower(coalesce(c.name, '')), lower(btrim(p_keyword))) > 0
        or strpos(lower(coalesce(c.address, '')), lower(btrim(p_keyword))) > 0
        or strpos(lower(coalesce(o.name, '')), lower(btrim(p_keyword))) > 0
        or (regexp_replace(p_keyword, '[^0-9]', '', 'g') <> '' and (
          strpos(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), regexp_replace(p_keyword, '[^0-9]', '', 'g')) > 0
          or strpos(regexp_replace(coalesce(o.phone, ''), '[^0-9]', '', 'g'), regexp_replace(p_keyword, '[^0-9]', '', 'g')) > 0
          or strpos(regexp_replace(coalesce(c.business_number, ''), '[^0-9]', '', 'g'), regexp_replace(p_keyword, '[^0-9]', '', 'g')) > 0
        ))
      )
    order by c.created_at desc, c.id desc
    limit p_limit + 1;
end;
$$;

revoke all on function public.admin_list_centers_page(text, text, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.admin_list_centers_page(text, text, integer, timestamptz, uuid) to authenticated;

commit;
