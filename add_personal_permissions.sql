-- ============================================================
-- 개인별 권한 예외 기능 추가 (역할 + 사람별 권한)
--
-- 하는 일:
--   1) account_center_permissions 테이블 생성 (allow/deny 예외)
--   2) has_permission() 함수를 오너/deny/allow/역할 우선순위로 재정의
--   3) 조회/설정 정책 (오너만 = facility.role_permission 권한)
--
-- 판정 우선순위:
--   1) 오너면 항상 허용 (deny도 무시)
--   2) 개인 deny → 차단
--   3) 개인 allow → 허용
--   4) 역할 권한 있으면 허용
--   5) 아니면 차단
--
-- DB 재생성 불필요. 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================


-- ------------------------------------------------------------
-- [1] 개인별 권한 예외 테이블
-- ------------------------------------------------------------
create table if not exists account_center_permissions (
    id                 uuid primary key default gen_random_uuid(),
    manager_center_id  uuid not null references manager_centers(id) on delete cascade,
    permission_key     text not null references permissions(key) on delete cascade,
    grant_type         text not null check (grant_type in ('allow', 'deny')),
    created_at         timestamptz not null default now(),
    unique (manager_center_id, permission_key)
);

comment on table account_center_permissions is
    '개인별 권한 예외. allow=역할에 없어도 부여, deny=역할에 있어도 차단';


-- ------------------------------------------------------------
-- [2] has_permission() 재정의
-- ------------------------------------------------------------
create or replace function has_permission(p_center_id uuid, p_permission text)
returns boolean
language sql stable
as $$
    with me as (
        select mc.id as mc_id, r.is_owner, mc.role_id
        from manager_centers mc
        join center_roles r on r.id = mc.role_id
        where mc.account_id = my_account_id()
          and mc.center_id = p_center_id
          and mc.status = 'active'
        limit 1
    )
    select coalesce((
        select
            case
                when m.is_owner then true
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'deny'
                ) then false
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'allow'
                ) then true
                when exists (
                    select 1 from role_permissions rp
                    where rp.role_id = m.role_id
                      and rp.permission_key = p_permission
                ) then true
                else false
            end
        from me m
    ), false);
$$;


-- ------------------------------------------------------------
-- [3] 정책 (오너만 조회/설정)
-- ------------------------------------------------------------
alter table account_center_permissions enable row level security;

drop policy if exists "개인권한 조회" on account_center_permissions;
create policy "개인권한 조회"
    on account_center_permissions for select
    using (
        manager_center_id in (
            select id from manager_centers
            where center_id in (select my_managed_center_ids())
        )
    );

drop policy if exists "개인권한 생성" on account_center_permissions;
create policy "개인권한 생성"
    on account_center_permissions for insert
    with check (
        manager_center_id in (
            select mc.id from manager_centers mc
            where has_permission(mc.center_id, 'facility.role_permission')
        )
    );

drop policy if exists "개인권한 수정" on account_center_permissions;
create policy "개인권한 수정"
    on account_center_permissions for update
    using (
        manager_center_id in (
            select mc.id from manager_centers mc
            where has_permission(mc.center_id, 'facility.role_permission')
        )
    )
    with check (
        manager_center_id in (
            select mc.id from manager_centers mc
            where has_permission(mc.center_id, 'facility.role_permission')
        )
    );

drop policy if exists "개인권한 삭제" on account_center_permissions;
create policy "개인권한 삭제"
    on account_center_permissions for delete
    using (
        manager_center_id in (
            select mc.id from manager_centers mc
            where has_permission(mc.center_id, 'facility.role_permission')
        )
    );


-- ============================================================
-- 확인
-- ============================================================
select 'account_center_permissions 테이블' as 항목,
       (select count(*)::text from account_center_permissions) as 값
union all
select '정책 수',
       (select count(*)::text from pg_policies where tablename = 'account_center_permissions');


-- ============================================================
-- 완료!
--   → 매니저 대시보드 → 스태프 & 권한 → [스태프] 탭
--   → 스태프 클릭 → "개인 권한 설정 (역할 예외)"
--   → 각 권한을 눌러 역할따름 → 허용추가 → 차단 순환
-- ============================================================
