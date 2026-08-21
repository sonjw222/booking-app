-- ============================================================
-- P2-11: 사업자등록번호 중복 방지 + 센터 등록 원자화
--
-- 하는 일:
--   1) centers.business_number에 unique 제약(부분 인덱스, 빈 값/NULL 제외) 추가
--   2) register_center_for_account_safe() RPC 신설 — 기존에 클라이언트가 4단계로
--      나눠 호출하던(centers insert → manager_centers insert → center_roles 조회
--      → manager_centers update) 로직을 하나의 트랜잭션으로 묶음(security definer)
--
-- 왜 security definer가 필요한가:
--   기존 4단계는 각각 별도 REST 요청이라 각자의 RLS 정책이 그때그때 적용됐다
--   ("매니저센터 생성" INSERT 정책의 center_is_pending()/manager_centers_has_any_row()
--   등). 하나의 함수로 묶으면 이 정책들을 우회하게 되므로, 아래 함수 본문 안에서
--   그 정책들이 원래 강제하던 조건(본인 계정으로만 등록, 오너 역할만 연결)을
--   동일하게 다시 확인한다 — RLS를 느슨하게 만드는 목적이 아니라 원자성만 얻기 위함.
--
-- 실행 전 확인 (읽기 전용 진단으로 이미 확인됨, 2026-08-22):
--   - centers.business_number 중복 행 없음 → unique 인덱스가 실패 없이 생성됨
--   - 위 진단에서 확인한 라이브 RLS 정책(pg_policies) 기준으로 아래 함수를 작성함:
--     · centers INSERT: auth.uid() IS NOT NULL 만 확인(소유자 제한 없음)
--     · manager_centers INSERT(자가등록): account_id=my_account_id(), role_id IS NULL,
--       해당 center_id에 기존 행 없음, centers.status='pending'
--     · manager_centers UPDATE(오너 역할 연결): 기존 행 없음(본인 행 제외) 상태에서
--       role_id를 그 센터의 오너 역할로, status='active'로 설정
--
-- DB 재생성 불필요. 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다(unique 인덱스는 IF NOT EXISTS, 함수는 OR REPLACE).
-- ============================================================


-- ------------------------------------------------------------
-- [1] business_number 중복 방지 (빈 값/NULL은 여러 개 허용 — 아직 사업자등록번호를
--     안 받는 다른 흐름이 생기더라도 막지 않기 위한 부분 인덱스)
-- ------------------------------------------------------------
create unique index if not exists centers_business_number_unique
    on centers (business_number)
    where business_number is not null and business_number <> '';


-- ------------------------------------------------------------
-- [2] 센터 등록 트랜잭션 RPC
-- ------------------------------------------------------------
create or replace function register_center_for_account_safe(
    p_name text,
    p_address text,
    p_phone text,
    p_business_number text,
    p_business_license_url text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account_id uuid;
    v_center_id uuid;
    v_owner_role_id uuid;
begin
    v_account_id := my_account_id();
    if v_account_id is null then
        raise exception '로그인이 필요해요';
    end if;

    if coalesce(trim(p_name), '') = '' then
        raise exception '센터 이름을 입력해주세요';
    end if;
    if coalesce(trim(p_address), '') = '' then
        raise exception '센터 주소를 입력해주세요';
    end if;
    if coalesce(trim(p_phone), '') = '' then
        raise exception '센터 대표번호를 입력해주세요';
    end if;
    if coalesce(trim(p_business_number), '') = '' then
        raise exception '사업자등록번호를 입력해주세요';
    end if;
    if coalesce(trim(p_business_license_url), '') = '' then
        raise exception '사업자등록증을 첨부해주세요';
    end if;

    v_center_id := gen_random_uuid();

    begin
        -- status는 지정하지 않음 → 기본값 'pending'(플랫폼 관리자 승인 대기)
        insert into centers (id, name, address, phone, business_number, business_license_url)
        values (v_center_id, p_name, p_address, p_phone, p_business_number, p_business_license_url);
    exception when unique_violation then
        raise exception '이미 등록된 사업자등록번호예요';
    end;

    -- 방금 만든 v_center_id는 이 트랜잭션 안에서 막 생성했으므로 다른 manager_centers
    -- 행이 이미 참조하고 있을 수 없다 — "오너 스태프 자가등록" RLS 정책이 원래 확인하던
    -- "센터당 최초 1명" 조건을 자동으로 만족한다.
    insert into manager_centers (account_id, center_id, status)
    values (v_account_id, v_center_id, 'active');

    -- centers AFTER INSERT 트리거(create_default_center_roles)가 같은 트랜잭션 안에서
    -- 이미 실행되어 오너/매니저/강사 3개 역할을 만들어둔 상태 — 바로 조회 가능.
    select id into v_owner_role_id
    from center_roles
    where center_id = v_center_id and role_key = 'owner';

    if v_owner_role_id is null then
        raise exception '오너 역할 연결 중 문제가 발생했어요: 기본 역할이 생성되지 않았어요';
    end if;

    update manager_centers
    set role_id = v_owner_role_id
    where account_id = v_account_id and center_id = v_center_id;

    return v_center_id;
end;
$$;

revoke all on function register_center_for_account_safe(text, text, text, text, text) from public;
revoke all on function register_center_for_account_safe(text, text, text, text, text) from anon;
grant execute on function register_center_for_account_safe(text, text, text, text, text) to authenticated;


-- ============================================================
-- 확인
-- ============================================================
select 'centers_business_number_unique 인덱스' as 항목,
       (select count(*)::text from pg_indexes where indexname = 'centers_business_number_unique') as 값
union all
select 'register_center_for_account_safe 함수',
       (select count(*)::text from pg_proc where proname = 'register_center_for_account_safe');
