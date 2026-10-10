-- ============================================================
-- [SQL 2/2] centers 민감 컬럼 SELECT 차단 — anon/authenticated 컬럼 단위 권한 (2026-10-09)
-- ============================================================
-- 문제: anon/authenticated가 centers 테이블 전체 SELECT 권한을 갖고 있어, RLS("승인된 센터 조회", 행 단위)를 통과하는 공개 센터의
--       business_number / business_license_url / reject_reason 이 누구에게나 조회된다(RLS는 컬럼을 거르지 못한다).
-- 수정: PostgreSQL에서 컬럼 REVOKE만으로는 효과가 없다 — 테이블 단위 SELECT가 남아 있으면 모든 컬럼이 읽힌다.
--       그래서 ① anon/authenticated의 테이블 단위 SELECT를 회수하고 ② "명시적 허용 목록"의 공개 컬럼에만 SELECT를 다시 부여한다.
--       (REVOKE 시 컬럼 단위 권한도 함께 정리된다.) 허용 목록은 2026-10-09 Production에서 확인한 centers 22개 컬럼 중
--       민감 3개를 뺀 19개다. 적용 전에 실제 컬럼 집합이 (허용 19 + 민감 3)과 정확히 같은지 검사하고, 예상 밖 컬럼이 있거나
--       빠진 컬럼이 있으면 아무것도 바꾸지 않고 예외로 중단한다 — 새 컬럼이 검토 없이 공개되는 일이 없다.
-- 건드리지 않는 것: RLS 정책, INSERT/UPDATE 권한, service_role, 트리거, 데이터. 센터 등록(register_center_for_account_safe)·
--       트리거·기타 SECURITY DEFINER 함수는 소유자 권한이라 영향 없음.
-- 중단되면: 예외 메시지의 unexpected/missing 컬럼을 확인하고, 공개해도 되는 컬럼이면 이 파일의 허용 목록(v_public)에 넣은 뒤 다시 실행한다.
-- 영향: 클라이언트에서 centers에 select('*') 또는 민감 컬럼 select는 42501(permission denied)이 된다 — 앱에는 그런 코드가 없다
--       (관리자 화면은 SQL 1의 admin_list_centers RPC로 이전). 앞으로 centers에 컬럼을 추가하면 공개해도 되는 컬럼에 한해
--       grant select (새컬럼) on public.centers to anon, authenticated; 를 같이 실행해야 클라이언트가 읽을 수 있다.
-- 선행 조건: SQL 1 적용 + 관리자 화면(RPC 호출 코드) 배포 완료. 먼저 막으면 /admin/centers 목록이 일시적으로 실패한다.
-- 원자성: 한 트랜잭션. 안전 확인(검사 블록)이 하나라도 실패하면 예외로 전체가 롤백된다.
-- 재실행: 안전(이미 적용돼 있어도 같은 결과).
-- 롤백: rollback_fix_centers_sensitive_column_privileges_20261009.sql / 확인: verify_fix_centers_sensitive_column_privileges_20261009.sql
-- ⚠ Claude Code 세션에서 실행되지 않았다 — 사용자가 SQL Editor에서 직접 확인 후 실행.
-- ============================================================

begin;

do $$
declare
    -- 공개(anon/authenticated SELECT 허용) 컬럼 — 2026-10-09 Production centers 스키마 기준 19개
    v_public    text[] := array[
        'id', 'name', 'categories', 'address', 'phone', 'intro', 'intro_blocks', 'pay_methods',
        'photo_url', 'sns', 'latitude', 'longitude', 'status', 'payment_methods', 'created_at',
        'instagram', 'kakao', 'review_point', 'is_internal'];
    -- 차단 컬럼
    v_sensitive text[] := array['business_number', 'business_license_url', 'reject_reason'];
    v_actual    text[];
    v_expected  text[];
    v_unexpected text[];
    v_missing    text[];
    v_col text;
begin
    select coalesce(array_agg(a.attname::text order by a.attname), '{}')
      into v_actual
      from pg_attribute a
     where a.attrelid = 'public.centers'::regclass
       and a.attnum > 0 and not a.attisdropped;
    select array_agg(x order by x) into v_expected from unnest(v_public || v_sensitive) x;

    select coalesce(array_agg(x order by x), '{}') into v_unexpected from unnest(v_actual) x where x <> all (v_expected);
    select coalesce(array_agg(x order by x), '{}') into v_missing from unnest(v_expected) x where x <> all (v_actual);
    if v_unexpected <> '{}' or v_missing <> '{}' then
        raise exception 'centers 컬럼이 예상과 다릅니다 — 적용 중단. unexpected(실제에만 있음)=%, missing(예상에만 있음)=%', v_unexpected, v_missing;
    end if;

    revoke select on table public.centers from anon, authenticated;
    foreach v_col in array v_public loop
        execute format('grant select (%I) on table public.centers to anon, authenticated', v_col);
    end loop;

    -- 적용 결과 자체 검사: 민감 컬럼은 anon/authenticated 모두 읽을 수 없어야 하고, 공개 컬럼은 모두 읽을 수 있어야 한다
    foreach v_col in array v_sensitive loop
        if has_column_privilege('anon', 'public.centers', v_col, 'select')
           or has_column_privilege('authenticated', 'public.centers', v_col, 'select') then
            raise exception '민감 컬럼(%) 권한이 여전히 열려 있습니다(PUBLIC 등 다른 경로의 grant 확인 필요) — 전체 롤백', v_col;
        end if;
    end loop;
    if has_table_privilege('anon', 'public.centers', 'select') or has_table_privilege('authenticated', 'public.centers', 'select') then
        raise exception '테이블 단위 SELECT가 남아 있습니다 — 전체 롤백';
    end if;
    foreach v_col in array v_public loop
        if not (has_column_privilege('anon', 'public.centers', v_col, 'select')
                and has_column_privilege('authenticated', 'public.centers', v_col, 'select')) then
            raise exception '공개 컬럼(%) 권한 부여에 실패했습니다 — 전체 롤백', v_col;
        end if;
    end loop;
end
$$;

commit;
