-- ============================================================
-- 스태프 초대 검색 개인정보 축소(2026-10-04).
-- 문제: accounts SELECT RLS "계정 조회"의 마지막 절 —
--   exists(manager_centers mc join center_roles r ... where mc.account_id = my_account_id() and mc.status='active' and (r.is_owner or facility.staff.create))
--   — 은 "대상 계정과 아무 관계 없이" 어느 센터에서든 owner이거나 facility.staff.create 권한이 있으면 accounts 전체를 SELECT할 수 있게 한다
--   (스태프 초대 검색용, fix_staff_search.sql). lib/roles.ts searchAccounts()는 이를 이용해 accounts를 이름/전화 부분일치(ilike)로 직접 조회했다(화면 limit 10은 DB 노출 범위를 줄이지 못함).
-- 해결(회원 추가 검색 search_member_candidates와 같은 원칙):
--   1) 센터 단위 전용 RPC search_staff_candidates(p_center_id, p_phone): 요청한 센터에 대해 facility.staff.create 권한(has_permission)이 서버에서 확인돼야 하고,
--      센터 밖 가입자는 "정확한 전체 휴대폰 번호"로만 찾는다(이름/번호 일부/이메일 조각 전역 검색 없음). 입력과 저장 phone은 kr_phone_digits로 같은 규칙 정규화(+82/하이픈/공백).
--      병합(merged_into)/비활성(deactivated_at) 계정 제외. 결과는 최소 정보(account id, 이름, 마스킹 번호, 이미 이 센터 스태프 여부/상태). 같은 번호로 활성 계정이 둘 이상 매칭되는 데이터 이상이면 임의로 하나를 고르지 않고 0건으로 응답한다(오류로 중복 존재를 알리지 않고, 시도 기록도 rollback되지 않음).
--   2) accounts "계정 조회"에서 위 전역 절만 제거. 유지: 본인 / 계정 연동 identity / 내가 관리하는 센터의 스태프 계정 / 내가 관리하는 센터 회원의 계정(Production 라이브 정의 그대로).
--   3) 번호 열거(enumeration) 방어: 정확한 전체 번호 검색 "시도"(유효한 휴대폰 번호 형식의 호출) 자체를 서버에서 rate limit 한다 — (호출 계정, 센터) 10분 30회 + 계정 24시간 200회,
--      advisory lock으로 같은 계정의 동시 호출을 직렬화, 한도 초과는 generic 오류. 권한 확인 뒤에만 카운트하므로 권한 없는 호출은 시도를 소모하지도, 한도 오류로 존재 여부를 알 수도 없다.
--      결과가 있었는지/없었는지와 무관하게 모든 전체 번호 시도를 센다(결과 유무가 rate limit 동작으로 새지 않는다). 형식이 완전하지 않은 입력은 어차피 아무것도 찾지 않으므로 세지 않는다.
--      시도 기록은 이 검색 전용 테이블 staff_candidate_search_attempts(caller_account_id, center_id, created_at만; 번호/검색어 미저장)에 쌓는다 — 회원 검색용 member_candidate_search_attempts와
--      의도적으로 분리했다(두 migration이 서로 다른 시점에 적용/롤백될 수 있어 공용 테이블은 적용 순서 의존과 rollback 결합을 만든다). 2일 지난 행은 호출 중 삭제.
--      함수는 기록을 쓰므로 VOLATILE.
-- 선행 조건: add_member_candidate_search_20261003.sql(kr_phone_digits) 적용됨, has_permission/my_managed_center_ids 존재.
-- 이 세션에서는 production에 실행하지 않았습니다. 적용 전/후 verify_fix_staff_account_search_privacy_20261004.sql(읽기 전용)로 확인하세요.
-- ============================================================
begin;

create table if not exists public.staff_candidate_search_attempts (
    id                 uuid primary key default gen_random_uuid(),
    caller_account_id  uuid not null,
    center_id          uuid not null,
    created_at         timestamptz not null default now()
);
create index if not exists idx_staff_candidate_search_attempts_caller_created
    on public.staff_candidate_search_attempts (caller_account_id, created_at desc);
create index if not exists idx_staff_candidate_search_attempts_created
    on public.staff_candidate_search_attempts (created_at);
alter table public.staff_candidate_search_attempts enable row level security;
revoke all on public.staff_candidate_search_attempts from public, anon, authenticated;

create or replace function public.search_staff_candidates(p_center_id uuid, p_phone text)
returns table (account_id uuid, name text, phone text, already_staff boolean, staff_status text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
    v_digits  text;
    v_ids     uuid[];
    v_caller  uuid := public.my_account_id();
    v_lock_key bigint;
    v_recent  int;
    v_daily   int;
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

    -- [rate limit] 전체 번호 exact-search 시도를 센다(권한 확인 뒤, 검색 전). (계정, 센터) 10분 30회 + 계정 24시간 200회.
    if v_caller is null then
        raise exception '로그인이 필요해요';
    end if;
    v_lock_key := ('x' || substr(md5(v_caller::text), 1, 16))::bit(64)::bigint;
    perform pg_advisory_xact_lock(v_lock_key);   -- 같은 계정의 동시 호출 직렬화
    select count(*) filter (where center_id = p_center_id and created_at >= now() - interval '10 minutes'), count(*)
      into v_recent, v_daily
      from public.staff_candidate_search_attempts
     where caller_account_id = v_caller and created_at >= now() - interval '24 hours';
    if v_recent >= 30 or v_daily >= 200 then
        raise exception '검색 요청이 너무 많아요. 잠시 후 다시 시도해주세요' using errcode = 'P0001';
    end if;
    insert into public.staff_candidate_search_attempts (caller_account_id, center_id) values (v_caller, p_center_id);
    delete from public.staff_candidate_search_attempts where created_at < now() - interval '2 days';

    select array_agg(a.id) into v_ids
      from public.accounts a
     where public.kr_phone_digits(a.phone) = v_digits
       and a.merged_into is null
       and a.deactivated_at is null;

    if v_ids is null then
        return;
    end if;
    if array_length(v_ids, 1) > 1 then
        -- 정규화하면 같은 번호인 활성 계정이 여러 개(데이터 이상): 임의의 한 계정을 고르지 않고 0건으로 응답한다.
        -- exception을 쓰지 않는다 — 함수가 예외로 끝나면 위에서 INSERT한 rate-limit 시도 기록도 같은 트랜잭션에서 롤백돼
        -- "유효한 전체 번호 시도는 결과와 무관하게 센다"는 보장이 깨지고, 오류 문구가 번호 중복 계정의 존재를 외부에 알려주기도 한다.
        -- (데이터 이상의 진단은 서버/운영 쪽에서: select kr_phone_digits(phone), count(*) from accounts where merged_into is null and deactivated_at is null group by 1 having count(*) > 1 — 이 API 응답으로는 노출하지 않는다.)
        return;
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
