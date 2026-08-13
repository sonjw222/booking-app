-- ============================================================
-- SEC-102/103(P1): accounts/profiles "매니저 계정/대표프로필 검색" 시스템 전체 노출
--
-- [근본 원인] "매니저 계정 검색"(accounts SELECT)과 "매니저 대표프로필 검색"(profiles
-- SELECT, is_primary=true)의 USING 절이 둘 다
--   exists(select 1 from manager_centers mc where mc.account_id = my_account_id()
--          and mc.status = 'active')
-- 뿐이다 — 검색 대상 행(피검색자)과 아무 관계가 없다. 즉 "이 계정이 어딘가에서 active
-- 매니저이기만 하면" accounts/profiles(is_primary) 테이블 전체를 SELECT할 수 있다.
-- SEC-101(임의 센터 self-join)을 완전히 막아도 독립 취약점으로 남는다 — 정상적으로
-- 자기 센터 하나를 합법적으로 부트스트랩한 오너라도 이 조건을 만족해 시스템 전체 회원
-- 검색 권한을 갖게 된다(docs/TODO.md SEC-102/103 항목 참고).
--
-- 두 정책을 소비하는 유일한 코드는 lib/members.ts의 searchAccountsForMember() —
-- "매니저가 신규 회원을 센터에 등록"할 때 아직 그 센터에 없는 사람을 이름/전화로 찾는
-- 기능이다(app/manager/members/page.tsx). 이 기능 자체는 정상 요구사항(신규 회원은
-- 정의상 아직 center_members에 없으므로 center_members로 스코핑할 수 없음)이지만,
-- 지금처럼 RLS SELECT 정책으로 테이블 전체를 열어두는 대신, 권한 체크 + 최소 필드만
-- 반환하는 전용 RPC로 좁힌다.
--
-- [이 파일이 하는 일]
-- 1) "매니저 계정 검색"(accounts)/"매니저 대표프로필 검색"(profiles) 정책 제거 —
--    이 두 정책을 대체하는 유일한 소비처(searchAccountsForMember)가 RPC로 이전되므로
--    더 이상 필요 없다.
-- 2) search_accounts_for_member(p_keyword) 신규 RPC — customer.member.create 권한을
--    가진 센터가 하나라도 있는지 확인한 뒤(기존 RLS와 달리 실제 권한 체크 추가),
--    profile_id/name/phone 3개 필드만 반환(그 외 계정 정보는 노출 안 함).
--
-- [영향받는 기존 데이터] 없음(정책 제거 + RPC 추가만, 테이블 데이터 변경 없음).
-- [코드 변경] lib/members.ts의 searchAccountsForMember()가 이 RPC를 호출하도록 이미
-- 교체됨(app/manager/members/page.tsx는 호출 시그니처가 그대로라 무변경).
-- [위험도] 낮음 — 기능적으로는 동일한 검색(이름/전화 부분일치, 최대 20건)을 유지하면서
-- 접근 조건만 "어디서든 active 매니저"에서 "회원 등록 권한이 있는 센터가 있음"으로 좁힘.
-- 정상적으로 회원을 등록하는 매니저(오너 포함, 오너는 has_permission()에서 is_owner로
-- 항상 true)는 계속 동일하게 동작한다.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- [1] 권한 체크 없이 시스템 전체를 열어주던 정책 2개 제거
-- ------------------------------------------------------------
drop policy if exists "매니저 계정 검색" on accounts;
drop policy if exists "매니저 대표프로필 검색" on profiles;

-- ------------------------------------------------------------
-- [2] search_accounts_for_member() — customer.member.create 권한이 있는 센터가
--     하나라도 있어야 검색 가능. 대표 프로필의 이름/전화만 반환(그 외 계정 필드 노출 안 함).
-- ------------------------------------------------------------
create or replace function search_accounts_for_member(p_keyword text)
returns table(profile_id uuid, name text, phone text)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_kw     text := trim(p_keyword);
    v_digits text := regexp_replace(coalesce(p_keyword, ''), '[^0-9]', '', 'g');
begin
    if length(v_kw) < 2 then
        return;
    end if;

    if not exists (
        select 1 from manager_centers mc
        where mc.account_id = my_account_id()
          and mc.status = 'active'
          and has_permission(mc.center_id, 'customer.member.create')
    ) then
        raise exception '회원 등록 권한이 없어요';
    end if;

    return query
    select p.id, p.name, a.phone
    from profiles p
    join accounts a on a.id = p.account_id
    where p.is_primary = true
      and (
          p.name ilike '%' || v_kw || '%'
          or (length(v_digits) >= 2 and a.phone ilike '%' || v_digits || '%')
      )
    limit 20;
end;
$$;

revoke all on function search_accounts_for_member(text) from public;
revoke all on function search_accounts_for_member(text) from anon;
grant execute on function search_accounts_for_member(text) to authenticated;

COMMIT;

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select policyname from pg_policies
where (tablename = 'accounts' and policyname = '매니저 계정 검색')
   or (tablename = 'profiles' and policyname = '매니저 대표프로필 검색');
-- 위 쿼리가 0행이어야 정상(정책 제거됨).

select routine_name, security_type from information_schema.routines
where routine_name = 'search_accounts_for_member';
