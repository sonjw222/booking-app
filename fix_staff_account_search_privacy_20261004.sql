-- ============================================================
-- 스태프 초대 검색 개인정보 축소(2026-10-04).
-- 문제: accounts SELECT RLS "계정 조회"의 마지막 절 —
--   exists(manager_centers mc join center_roles r ... where mc.account_id = my_account_id() and mc.status='active' and (r.is_owner or facility.staff.create))
--   — 은 "대상 계정과 아무 관계 없이" 어느 센터에서든 owner이거나 facility.staff.create 권한이 있으면 accounts 전체를 SELECT할 수 있게 한다
--   (스태프 초대 검색용, fix_staff_search.sql). lib/roles.ts searchAccounts()는 이를 이용해 accounts를 이름/전화 부분일치(ilike)로 직접 조회했다(화면 limit 10은 DB 노출 범위를 줄이지 못함).
-- 해결(회원 추가 검색 search_member_candidates와 같은 원칙):
--   1) 센터 단위 전용 RPC search_staff_candidates(p_center_id, p_phone): 요청한 센터에 대해 facility.staff.create 권한(has_permission)이 서버에서 확인돼야 하고,
--      센터 밖 가입자는 "정확한 전체 휴대폰 번호"로만 찾는다(이름/번호 일부/이메일 조각 전역 검색 없음). 입력과 저장 phone은 kr_phone_digits로 같은 규칙 정규화(+82/하이픈/공백).
--      병합(merged_into)/비활성(deactivated_at) 계정 제외. 결과는 최소 정보(account id, 이름, 마스킹 번호, 이미 이 센터 스태프 여부/상태). 같은 번호로 계정이 둘 이상 매칭되면 임의로 하나를 고르지 않고 거부한다.
--   2) accounts "계정 조회"에서 위 전역 절만 제거. 유지: 본인 / 계정 연동 identity / 내가 관리하는 센터의 스태프 계정 / 내가 관리하는 센터 회원의 계정(Production 라이브 정의 그대로).
-- 선행 조건: add_member_candidate_search_20261003.sql(kr_phone_digits) 적용됨, has_permission/my_managed_center_ids 존재.
-- 이 세션에서는 production에 실행하지 않았습니다. 적용 전/후 verify_fix_staff_account_search_privacy_20261004.sql(읽기 전용)로 확인하세요.
-- ============================================================
begin;

create or replace function public.search_staff_candidates(p_center_id uuid, p_phone text)
returns table (account_id uuid, name text, phone text, already_staff boolean, staff_status text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_digits  text;
    v_ids     uuid[];
begin
    if auth.uid() is null then
        raise exception '로그인이 필요해요';
    end if;
    -- 요청한 "그 센터"에 대한 권한만 인정한다(다른 센터의 권한/오너 여부로는 불가).
    if p_center_id is null or not public.has_permission(p_center_id, 'facility.staff.create') then
        raise exception '스태프를 추가할 권한이 없어요';
    end if;

    v_digits := public.kr_phone_digits(p_phone);
    -- 정확한 전체 휴대폰 번호(01X 10~11자리)가 아니면 아무것도 찾지 않는다(부분 번호/이름 검색 금지).
    if v_digits !~ '^01[0-9]{8,9}$' then
        return;
    end if;

    select array_agg(a.id) into v_ids
      from public.accounts a
     where public.kr_phone_digits(a.phone) = v_digits
       and a.merged_into is null
       and a.deactivated_at is null;

    if v_ids is null then
        return;
    end if;
    if array_length(v_ids, 1) > 1 then
        -- 정규화하면 같은 번호인 계정이 여러 개(데이터 이상): 임의 선택/숨김 없이 거부하고 운영 확인을 요청한다.
        raise exception '같은 번호로 가입한 계정이 여러 개예요. 운영자에게 문의해주세요';
    end if;

    return query
    select a.id,
           a.name,
           left(v_digits, 3) || '-****-' || right(v_digits, 4),
           (mc.id is not null),
           mc.status
      from public.accounts a
      left join public.manager_centers mc on mc.account_id = a.id and mc.center_id = p_center_id
     where a.id = v_ids[1];
end;
$$;

revoke all on function public.search_staff_candidates(uuid, text) from public, anon;
grant execute on function public.search_staff_candidates(uuid, text) to authenticated;

-- accounts "계정 조회": 대상과 무관한 전역 허용 절(owner / facility.staff.create) 제거 — 관계 기반 4개 절은 라이브 정의 그대로 유지
drop policy if exists "계정 조회" on public.accounts;
create policy "계정 조회"
    on public.accounts for select
    using (
        (auth_id = auth.uid())
        or (id in (
            select account_auth_identities.account_id
              from account_auth_identities
             where account_auth_identities.auth_id = auth.uid()
        ))
        -- 내가 관리하는 센터의 스태프 계정
        or (id in (
            select mc.account_id
              from manager_centers mc
             where mc.center_id in (select my_managed_center_ids())
        ))
        -- 내가 관리하는 센터 회원의 계정
        or (id in (
            select p.account_id
              from profiles p
              join center_members cm on cm.profile_id = p.id
             where cm.center_id in (select my_managed_center_ids())
        ))
    );

commit;
