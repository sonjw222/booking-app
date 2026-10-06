-- fix_member_candidate_search_rate_limit_20261004.sql 롤백: search_member_candidates를 rate limit 없는 직전 정의(add_member_candidate_search_20261003.sql, STABLE)로 되돌리고
-- 시도 기록 테이블을 제거한다. 다른 데이터는 건드리지 않는다. 롤백하면 외부 번호 enumeration 호출 제한이 다시 없어진다.
begin;

create or replace function public.search_member_candidates(p_center_id uuid, p_keyword text)
returns table (profile_id uuid, name text, phone text, already_member boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_kw      text := trim(coalesce(p_keyword, ''));
    v_digits  text := public.kr_phone_digits(p_keyword);
    v_exact   text;
    v_can_phone boolean;
begin
    if p_center_id is null or not public.has_permission(p_center_id, 'customer.member.create') then
        raise exception '회원 등록 권한이 없어요';
    end if;
    -- 기존 센터 회원의 전화번호를 보거나 전화로 검색할 수 있는지: fetch_member_phones_safe와 같은 기준(customer.member.phone 또는 platform admin). 권한 검사는 데이터 조회 전에 끝낸다.
    v_can_phone := public.has_permission(p_center_id, 'customer.member.phone') or public.is_platform_admin();
    if length(v_kw) < 2 then
        return;
    end if;

    -- 정규화된 입력이 완전한 휴대폰 번호(01X 10~11자리)일 때만 "정확 일치" 후보로 쓴다.
    if v_digits ~ '^01[0-9]{8,9}$' then
        v_exact := v_digits;
    end if;

    return query
    with members as (
        -- 이 센터에 이미 등록된 회원(대표 프로필): 이름/전화 일부 검색. position()으로 비교해 %, _가 wildcard로 동작하지 않는다.
        select p.id as pid, p.name as pname, case when v_can_phone then a.phone else null end as pphone
          from public.center_members cm
          join public.profiles p on p.id = cm.profile_id and p.deleted_at is null
          join public.accounts a on a.id = p.account_id
         where cm.center_id = p_center_id
           and p.is_primary = true
           and (
                position(lower(v_kw) in lower(coalesce(p.name, ''))) > 0
                or (v_can_phone and length(v_digits) >= 2 and position(v_digits in public.kr_phone_digits(a.phone)) > 0)
           )
         limit 20
    ), exact as (
        -- 아직 이 센터에 없는 사람: 정확한 전체 번호만. 이름/마스킹 번호만 반환.
        select p.id as pid, p.name as pname, a.phone as pphone
          from public.accounts a
          join public.profiles p on p.account_id = a.id and p.is_primary = true and p.deleted_at is null
         where v_exact is not null
           and public.kr_phone_digits(a.phone) = v_exact
           and a.merged_into is null
           and a.deactivated_at is null
           and not exists (select 1 from public.center_members cm where cm.center_id = p_center_id and cm.profile_id = p.id)
         limit 5
    )
    select m.pid, m.pname, m.pphone, true from members m
    union all
    select e.pid, e.pname, left(v_exact, 3) || '-****-' || right(v_exact, 4), false from exact e;
end;
$$;

revoke all on function public.search_member_candidates(uuid, text) from public, anon;
grant execute on function public.search_member_candidates(uuid, text) to authenticated;

drop table if exists public.member_candidate_search_attempts;

commit;
