-- ============================================================
-- 플랫폼 운영자(센터 승인 담당) 추가
--
-- 하는 일:
--   1) accounts 에 is_platform_admin 컬럼 추가
--   2) is_platform_admin() 헬퍼 함수
--   3) 운영자가 모든 센터를 보고 승인/반려할 수 있게 정책 수정
--   4) 매니저가 자기 센터를 스스로 승인하지 못하게 차단(트리거)
--   5) 내 계정을 운영자로 지정  ← 아래 [5] 부분 수정 필요!
--
-- DB 재생성 불필요. 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================


-- ------------------------------------------------------------
-- [1] 컬럼 추가
-- ------------------------------------------------------------
alter table accounts
    add column if not exists is_platform_admin boolean not null default false;

comment on column accounts.is_platform_admin is
    '플랫폼 운영자. 센터 가입 승인/반려 권한. 일반 가입으로는 부여되지 않음';


-- ------------------------------------------------------------
-- [2] 헬퍼 함수
-- ------------------------------------------------------------
create or replace function is_platform_admin()
returns boolean
language sql stable
security definer
as $$
    select coalesce(
        (select is_platform_admin from accounts where auth_id = auth.uid()),
        false
    );
$$;


-- ------------------------------------------------------------
-- [3] 센터 조회/수정 정책에 운영자 권한 반영
-- ------------------------------------------------------------
drop policy if exists "승인된 센터 조회" on centers;
create policy "승인된 센터 조회"
    on centers for select using (
        status = 'approved'
        or id in (select my_managed_center_ids())
        -- 가입 직후 승인대기 상태인 내 센터도 보이게
        or id in (select center_id from manager_centers where account_id = my_account_id())
        -- 운영자는 심사를 위해 모든 센터(대기/반려 포함)를 볼 수 있어야 함
        or is_platform_admin()
    );

drop policy if exists "매니저 센터 수정" on centers;
create policy "매니저 센터 수정"
    on centers for update
    using (id in (select my_managed_center_ids()) or is_platform_admin())
    with check (id in (select my_managed_center_ids()) or is_platform_admin());


-- ------------------------------------------------------------
-- [4] 승인 상태 보호: status 변경은 운영자만
--     (매니저가 자기 센터를 스스로 approved 로 바꾸는 것 차단)
-- ------------------------------------------------------------
create or replace function guard_center_status_change()
returns trigger
language plpgsql
security definer
as $$
begin
    if new.status is distinct from old.status and not is_platform_admin() then
        raise exception '센터 승인 상태는 플랫폼 운영자만 변경할 수 있어요';
    end if;
    return new;
end;
$$;

drop trigger if exists trg_guard_center_status on centers;
create trigger trg_guard_center_status
    before update on centers
    for each row
    execute function guard_center_status_change();


-- ------------------------------------------------------------
-- [5] 내 계정을 플랫폼 운영자로 지정  ← 여기 수정하세요!
--
--     아래 이메일을 본인 계정 이메일로 바꾼 뒤 실행하세요.
--     (어떤 이메일이 있는지 확인:
--        select u.email, a.name from accounts a join auth.users u on u.id = a.auth_id;)
-- ------------------------------------------------------------
update accounts
set is_platform_admin = true
where auth_id = (
    select id from auth.users
    where email = '여기에_본인_이메일_입력'    -- ← 반드시 수정!
);


-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select a.name as 이름, u.email, a.is_platform_admin as 운영자여부
from accounts a
join auth.users u on u.id = a.auth_id
order by a.is_platform_admin desc, a.created_at;


-- ============================================================
-- 완료!
--   → 앱에서 그 계정으로 로그인 → 마이페이지 → "센터 승인 관리 (운영자)"
--   → 또는 주소창에 /admin/centers 직접 입력
-- ============================================================
