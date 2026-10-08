-- ============================================================
-- centers INSERT guard — 승인 우회 차단 (P1, 2026-10-08)
-- ============================================================
-- 문제: RLS 정책 "센터 생성"이 WITH CHECK (auth.uid() IS NOT NULL) 뿐이고 authenticated에 테이블 권한(GRANT ALL)이 있어,
--       가입만 한 일반 사용자가 REST로 POST /rest/v1/centers {status:'approved', is_internal:...}를 보내면 운영자 승인(사업자등록증 검증)을
--       건너뛴 센터가 공개 목록/검색에 노출될 수 있다(업체 사칭/피싱). UPDATE 쪽은 trg_guard_center_status가 막지만 INSERT 쪽에는 가드가 없었다.
-- 수정: BEFORE INSERT 트리거로 DB가 불변식을 보장한다.
--   · JWT 없는 서버 작업(service_role, cron, SQL Editor) → 그대로 허용(테스트 fixture/QA seed가 approved/internal 센터를 만든다; 기존 관례 auth.uid() is null)
--   · 플랫폼 운영자(is_platform_admin()) → 그대로 허용
--   · 그 외 로그인 사용자 → status는 항상 'pending', is_internal은 항상 false로 강제(값이 무엇이든 거부하지 않고 보정)
--   anon은 INSERT 정책이 auth.uid() IS NOT NULL을 요구해 어차피 거부된다.
-- 정상 센터 등록 경로(register_center_for_account_safe RPC)는 status/is_internal을 지정하지 않아 영향 없음. 기존 행은 변경하지 않는다.
-- RLS/기존 정책/UPDATE 가드는 건드리지 않는다. 롤백: rollback_fix_center_insert_guard_20261008.sql
-- ⚠ 이 SQL은 Claude Code 세션에서 실행되지 않았다 — 실행은 사용자가 Supabase SQL Editor에서 직접 확인 후 진행.
-- ============================================================

create or replace function public.guard_center_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    -- 로그인 사용자 JWT가 없는 서버 작업(service_role, cron, SQL Editor)은 통과
    if auth.uid() is null then
        return new;
    end if;
    -- 플랫폼 운영자는 통과
    if is_platform_admin() then
        return new;
    end if;
    -- 일반 로그인 사용자: 승인 상태와 내부 QA 플래그는 클라이언트가 정할 수 없다
    new.status := 'pending';
    new.is_internal := false;
    return new;
end;
$$;

-- 트리거 전용 함수 — 직접 호출 대상이 아니므로 API 롤에서 EXECUTE를 회수한다(트리거 발동에는 영향 없음).
revoke all on function public.guard_center_insert() from public, anon, authenticated;

drop trigger if exists trg_guard_center_insert on public.centers;
create trigger trg_guard_center_insert
    before insert on public.centers
    for each row execute function public.guard_center_insert();
