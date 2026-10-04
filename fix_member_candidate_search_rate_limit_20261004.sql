-- ============================================================
-- 회원 추가 "정확한 전체 휴대폰 번호" 검색 rate limit(2026-10-04).
-- 문제: search_member_candidates(2026-10-03)는 센터의 customer.member.create 권한자가 정확한 전체 번호를 무제한 반복 시도하면
--       "그 번호가 가입자인지 + 이름"을 알아낼 수 있다(번호 enumeration). 노출은 이름/마스킹 번호로 제한됐지만 호출 빈도 제한이 없었다.
-- 해결: 외부 가입자 exact-phone 경로에만 서버측 rate limit(기존 패턴 consume_email_check_attempt: 전용 시도 기록 테이블 + advisory lock으로 확인+기록 원자화).
--   · 대상: v_exact(정규화된 완전한 휴대폰 번호) 검색만. 센터 회원 이름/전화 일부 검색은 제한하지 않는다(정상 운영 UX 보호).
--   · 키: (호출 계정, 센터) 10분 30회, 계정 전체 24시간 200회(여러 센터로 나눠 우회 방지). 선택 이유: 기존 이메일 사전확인은 IP당 10분 20회.
--     센터 운영자가 회원을 한 명씩 등록할 때 한 명당 정확 번호 검색은 보통 1~3회라 10분 30회면 연속 등록에 충분하고,
--     enumeration은 하루 최대 200건으로 제한된다(이전 무제한).
--   · 권한 검사(customer.member.create) 뒤에서만 카운트/거부 → 권한 없는 호출은 어떤 오류로도 존재 여부를 알 수 없음. anon은 기존처럼 실행 불가.
--   · 한도 초과 메시지는 generic("검색 요청이 너무 많아요. 잠시 후 다시 시도해주세요"). 초과 호출은 기록하지 않는다(대기 후 정상 복구).
--   · 시도 기록 테이블 member_candidate_search_attempts: RLS 활성화 + 정책 없음 + anon/authenticated 권한 전부 회수(client 직접 접근 불가, SECURITY DEFINER 함수만 기록).
--     전화번호/검색어는 저장하지 않는다(caller_account_id, center_id, created_at만). 2일 지난 행은 함수 호출 중 삭제.
--   · 함수는 이제 기록을 쓰므로 VOLATILE(이전 STABLE). 시그니처/반환/권한(authenticated만, search_path=public)은 그대로.
-- 선행 조건: add_member_candidate_search_20261003.sql 적용(kr_phone_digits, search_member_candidates), my_account_id/has_permission 존재.
-- 이 세션에서는 production에 실행하지 않았습니다. 적용 전후 verify_member_candidate_search_rate_limit_20261004.sql(읽기 전용)로 확인하세요.
-- ============================================================
begin;

create table if not exists public.member_candidate_search_attempts (
    id                 uuid primary key default gen_random_uuid(),
    caller_account_id  uuid not null,
    center_id          uuid not null,
    created_at         timestamptz not null default now()
);
create index if not exists idx_member_candidate_search_attempts_caller_created
    on public.member_candidate_search_attempts (caller_account_id, created_at desc);
create index if not exists idx_member_candidate_search_attempts_created
    on public.member_candidate_search_attempts (created_at);

alter table public.member_candidate_search_attempts enable row level security;
revoke all on public.member_candidate_search_attempts from public, anon, authenticated;

create or replace function public.search_member_candidates(p_center_id uuid, p_keyword text)
returns table (profile_id uuid, name text, phone text, already_member boolean)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
    v_kw      text := trim(coalesce(p_keyword, ''));
    v_digits  text := public.kr_phone_digits(p_keyword);
    v_exact   text;
    v_can_phone boolean;
    v_caller    uuid := public.my_account_id();
    v_lock_key  bigint;
    v_recent    int;
    v_daily     int;
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

    -- [rate limit] "정확한 전체 번호" 조회(센터 밖 가입자 존재 여부를 알아낼 수 있는 유일한 경로)만 호출 횟수를 제한한다. 이름/부분 검색은 제한하지 않는다.
    -- 권한 검사 뒤에 수행하므로 권한 없는 호출은 이 한도/오류로 개인정보 존재 여부를 알 수 없다. 서버에서 강제(client debounce는 보안 수단이 아님).
    -- 한도: (호출 계정, 센터)당 10분 30회 + 계정당 24시간 200회. 한도 초과 시 이번 호출은 기록하지 않고 generic 오류를 낸다.
    if v_exact is not null then
        if v_caller is null then
            raise exception '로그인이 필요해요';
        end if;
        v_lock_key := ('x' || substr(md5(v_caller::text), 1, 16))::bit(64)::bigint;
        perform pg_advisory_xact_lock(v_lock_key);   -- 같은 계정의 동시 호출을 직렬화(check-then-act race 방지)
        select count(*) filter (where center_id = p_center_id and created_at >= now() - interval '10 minutes'), count(*)
          into v_recent, v_daily
          from public.member_candidate_search_attempts
         where caller_account_id = v_caller and created_at >= now() - interval '24 hours';
        if v_recent >= 30 or v_daily >= 200 then
            raise exception '검색 요청이 너무 많아요. 잠시 후 다시 시도해주세요' using errcode = 'P0001';
        end if;
        insert into public.member_candidate_search_attempts (caller_account_id, center_id) values (v_caller, p_center_id);
        -- 보관 정리: 2일 지난 기록은 호출 중에 함께 지운다(한도 계산은 24시간만 사용).
        delete from public.member_candidate_search_attempts where created_at < now() - interval '2 days';
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

commit;
