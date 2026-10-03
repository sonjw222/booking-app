-- ============================================================
-- 관리자 "회원 추가" 검색 구조 정리(2026-10-03, Batch A) — 개인정보 노출 범위 최소화.
-- 문제: 현재 main의 searchAccountsForMember()는 profiles/accounts를 client에서 직접 SELECT한다. 결과는 로그인한 관리자 계정의 RLS에 따라 달라져
--       (플랫폼 관리자/owner/제한된 매니저/관계가 있는 사람만) 같은 앱에서도 계정마다 다르게 보였고, "아직 센터에 없는 신규 가입자를 전화번호로 찾기"는 구조적으로 동작하지 못했다.
--       과거 보안 수정(ae83da4)의 RPC search_accounts_for_member(p_keyword)는 Production에 있지만 main 코드가 쓰지 않고, 권한만 확인한 뒤 "시스템 전체 이름/전화 부분일치"를 허용한다(개인정보 과다 노출).
-- 해결: 센터 단위로 권한을 서버에서 확인하는 전용 RPC search_member_candidates(p_center_id, p_keyword).
--   · 호출자는 그 센터의 customer.member.create 권한(has_permission, owner 포함)이 있어야 한다 — 다른 센터 id/권한 없는 사용자/anon은 거부.
--   · 이 센터에 이미 등록된 회원: 이름은 누구나(2글자 이상, LIKE wildcard 비활성), 전화번호 "일부" 검색과 전체 전화번호 표시는 기존 보안 모델(fetch_member_phones_safe)과 같이
--     customer.member.phone 권한(또는 platform admin)이 있을 때만. 권한이 없으면 전화번호 일부 검색 불가 + 결과 phone은 NULL(전화번호 권한 우회 방지). already_member=true.
--   · 아직 이 센터에 없는 사람: "정확한 전체 휴대폰 번호"로만 찾는다(01012345678 / 010-1234-5678 / +82 10-1234-5678 모두 같은 번호로 정규화). 이름·전화 일부·이메일 조각으로는 절대 전역 검색하지 않는다.
--     결과는 최소 정보(profile_id, 이름, 마스킹된 전화번호 010-****-5678)만 반환한다(전화 권한과 무관하게 항상 마스킹, 전체 번호 반환 금지). 병합(merged_into)/비활성(deactivated_at) 계정, 삭제된 프로필은 제외.
--   · SECURITY DEFINER + search_path 고정, PUBLIC/anon execute 회수, authenticated만 실행.
--   · 기존 search_accounts_for_member(text)(전역 부분일치)는 앱이 쓰지 않으므로 authenticated 실행 권한을 회수한다(함수 자체는 삭제하지 않음 — rollback으로 복원 가능).
-- 전화번호 정규화: accounts.phone은 사용자가 입력한 문자열을 그대로 저장한다(OTP 인증도 입력 문자열 그대로) — 저장값이 01012345678 / 010-1234-5678 / +82 10-1234-5678 / 82 010… 형식일 수 있어,
--   입력과 저장값을 같은 규칙(숫자만 + 국제번호 82 → 0 + 0이 중복되면 하나만)으로 정규화한 뒤 비교한다(kr_phone_digits). 저장 데이터는 수정하지 않는다.
-- 이 migration은 accounts/profiles의 RLS 정책을 바꾸지 않는다. (참고: "계정 조회" 정책은 owner/staff.create 권한자에게 accounts 전체 조회를 허용한다 — 스태프 초대 검색용이며 별도 follow-up.)
-- 배포 순서: SQL 적용 → 웹 배포(웹이 먼저 나가면 검색 호출이 함수 없음 오류를 낸다). 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================
begin;

-- 전화번호 정규화(순수 함수): 숫자만 남기고, 국제번호(82…)는 국내 형식(0…)으로. "+82 10-…"과 "+82 010-…" 둘 다 01…로 맞춘다. 데이터는 바꾸지 않고 비교에만 쓴다.
create or replace function public.kr_phone_digits(p text)
returns text
language sql
immutable
set search_path = public
as $$
    select case
        when d ~ '^82' and length(d) between 11 and 13 then
            case when substr(d, 3) ~ '^0' then substr(d, 3) else '0' || substr(d, 3) end
        else d
    end
    from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x;
$$;
revoke all on function public.kr_phone_digits(text) from public, anon, authenticated;

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

-- 전역 부분일치 RPC 회수(앱 미사용). 함수가 없으면 건너뛴다.
do $$
begin
    if to_regprocedure('public.search_accounts_for_member(text)') is not null then
        execute 'revoke execute on function public.search_accounts_for_member(text) from public, anon, authenticated';
    end if;
end $$;

commit;
