-- ============================================================
-- [SQL 1/2] 플랫폼 관리자 전용 센터 목록 RPC admin_list_centers(p_status) (2026-10-09)
-- ============================================================
-- 배경: centers.business_number / business_license_url / reject_reason 이 anon·authenticated에게 그대로 조회된다.
--       그 컬럼을 막기(SQL 2) 전에, 관리자 승인 화면이 쓸 "관리자 전용" 읽기 경로를 먼저 만든다.
-- 성격: 추가만 한다(함수 1개). 기존 테이블/권한/정책/데이터는 건드리지 않는다 — 이 SQL만 적용해도 현재 앱은 영향 없음.
-- 보안:
--   · SECURITY DEFINER + search_path 고정(public, pg_temp) — 이 함수의 모든 객체 참조는 public.* 로 스키마 한정하고, 호출자의 search_path는 영향을 주지 못한다.
--     (빈 search_path('')는 쓰지 않는다: 호출하는 public.is_platform_admin()이 자체 search_path 설정이 없는 라이브 정의면 그 본문의 accounts 참조가 풀리지 않아 실패한다 — 테스트로 확인.)
--   · 첫 문장에서 public.is_platform_admin() IS NOT TRUE 로 "서버 측" 관리자 자격을 검증한다. 로그인만으로는 통과하지 못하고, NULL 반환도 거부한다(42501).
--   · EXECUTE: PUBLIC/anon/authenticated 전부 회수 후 authenticated 에만 부여(호출은 가능하되 내부 검증이 관리자만 통과).
--     anon 은 함수 호출 자체가 permission denied.
--   · 입력은 p_status 하나이며 pending/approved/rejected 외에는 거부한다(동적 SQL 없음).
-- 전제: 소유자는 RLS를 우회하는 역할(Supabase SQL Editor 기본 postgres) — 확인은 verify 파일 2번.
-- 반환 형태: 기존 lib/admin.ts fetchCenters 의 행 필드 + 대표 매니저(가장 먼저 연결된 계정)의 이름/전화.
-- 롤백: rollback_add_admin_list_centers_rpc_20261009.sql / 확인: verify_add_admin_list_centers_rpc_20261009.sql
-- 재실행: create or replace + revoke/grant 라 여러 번 실행해도 안전. 한 트랜잭션이라 중간 실패 시 전부 취소.
-- ⚠ Claude Code 세션에서 실행되지 않았다 — 사용자가 SQL Editor에서 직접 확인 후 실행.
-- ============================================================

begin;

create or replace function public.admin_list_centers(p_status text)
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

    return query
    select c.id, c.name, c.address, c.phone, c.business_number, c.business_license_url,
           c.status, c.reject_reason, c.created_at, o.name, o.phone
    from public.centers c
    left join lateral (
        select a.name, a.phone
        from public.manager_centers mc
        join public.accounts a on a.id = mc.account_id
        where mc.center_id = c.id
        order by mc.created_at asc
        limit 1
    ) o on true
    where c.status = p_status
    order by c.created_at desc;
end;
$$;

revoke all on function public.admin_list_centers(text) from public, anon, authenticated;
grant execute on function public.admin_list_centers(text) to authenticated;

commit;
