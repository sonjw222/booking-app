-- ============================================================
-- SEC-116(P2) + SEC-117(P3): SECURITY DEFINER RPC 하드닝 배치
-- (EXECUTE 최소화 + search_path 고정) — 로직 변경과 완전히 분리된 파일
--
-- ⚠ 대상에서 제외(별도 파일에서 이미 처리):
--   - auto_book_membership  → fix_auto_book_membership_idor_draft_proposed.sql (SEC-114, 로직도 변경)
--   - manager_set_attendance → fix_manager_set_attendance_membership_integrity_draft_proposed.sql (SEC-115, 로직도 변경)
--   - manager_centers 관련 정책/함수 → 별도 세션의 SEC-101/SEC-112 배치, 이 파일에서 손대지 않음
--
-- 이 파일이 다루는 함수들은 로직상 취약점이 아니라 "이미 내부에 올바른 소유자/
-- 권한 검사가 있는데 EXECUTE가 필요 이상으로 넓게 열려 있고 search_path가
-- 고정돼 있지 않다"는 하드닝(방어선 추가) 문제다. 그래서 CREATE OR REPLACE로
-- 함수 본문을 다시 쓰지 않고 ALTER FUNCTION(search_path)과 REVOKE/GRANT(권한)만
-- 쓴다 — 함수 로직은 단 한 글자도 바뀌지 않는다(설계 요건: "권한 정리는 함수
-- 로직 수정과 분리해서도 적용 가능하도록").
--
-- [SEC-116] EXECUTE 최소화 — 대상별 근거(전부 코드로 확인, 이번 배치에서 새로
-- 발견한 취약점 아님. 각 함수 안에 이미 있는 소유자/권한 검사가 anon/PUBLIC
-- 호출을 사실상 무력화하므로 지금 당장 뚫려 있는 건 아니지만, 불필요한 표면을
-- 남겨둘 이유가 없다):
--   - reserve_class(uuid,uuid): profiles.account_id = my_account_id() 확인 있음
--     → anon은 항상 "로그인이 필요" 예외. authenticated만 필요.
--   - reserve_with_membership(uuid,uuid,uuid): p_profile_id가 my_account_id()
--     소유인지 + membership이 my_account_id() 소유인지 이중 확인 있음 → 동일.
--   - cancel_reservation(uuid): reservation.profile_id가 my_account_id()의
--     프로필에 속하는지 확인 있음 → 동일.
--   - refund_membership(uuid): membership.profile_id가 my_account_id()의
--     프로필에 속하는지 확인 있음 → 동일.
--   - fulfill_order(uuid): v_order.center_id in my_managed_center_ids() or
--     is_platform_admin() 확인 있음 → anon/authenticated(비매니저)는 항상
--     "권한이 없어요" 예외. authenticated만 필요(매니저도 로그인 상태이므로).
--
-- [SEC-117] search_path 고정 — 위험도 평가 및 결론
--   SECURITY DEFINER 함수 본문의 미한정(스키마 접두사 없는) 객체 참조는, 만약
--   caller가 effective search_path 앞쪽에 있는 스키마에 같은 이름의 객체를
--   만들 수 있다면 그걸 대신 참조하게 만들 수 있다(전형적 search_path hijack).
--   이 저장소의 대상 함수들은 전부 public 스키마의 테이블/함수를 접두사 없이
--   참조한다. PostgreSQL 15부터 CREATE ON SCHEMA public이 PUBLIC 역할에서
--   기본적으로 회수돼 있고, Supabase는 PG15 기준으로 프로비저닝한다 — 즉
--   anon/authenticated가 public 스키마에 CREATE 권한을 갖는 것이 기본값이
--   아니다. 이 저장소의 다른 SQL 어디에도 "grant create on schema public"
--   구문이 없다(grep 확인) — 별도로 부여한 흔적도 없다.
--   → 결론: LIKELY 안전(실제 hijack 가능성 낮음), 하지만 이 파일만으로 100%
--   확정할 수 없다(has_schema_privilege는 Live SQL 실행이 필요 — 이번 작업
--   범위의 "Live SQL 실행 금지"에 걸림). 아래 "적용 후 확인" 절의 진단
--   쿼리로 사용자가 직접 확인할 것을 권장한다. 위험도와 무관하게 search_path
--   고정 자체는 완전히 무해하고(모든 대상 함수가 public 스키마 객체만 참조
--   하므로 동작 변화 없음) 비용이 사실상 0이므로 즉시 적용해도 안전하다.
--
-- [영향받는 기존 데이터] 없음(GRANT/REVOKE/ALTER FUNCTION만, 함수 본문·테이블·
-- 데이터 전부 무변경).
-- [위험도] 매우 낮음.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- search_path 고정 (로직 무변경 — ALTER FUNCTION만)
-- ------------------------------------------------------------
alter function reserve_class(uuid, uuid) set search_path = public;
alter function reserve_with_membership(uuid, uuid, uuid) set search_path = public;
alter function cancel_reservation(uuid) set search_path = public;
alter function refund_membership(uuid) set search_path = public;
alter function fulfill_order(uuid) set search_path = public;
alter function usable_memberships(uuid, uuid) set search_path = public;
alter function usable_memberships_for_classes(uuid[], uuid) set search_path = public;
-- is_platform_admin()은 RLS 정책 여러 곳에서 anon/authenticated 쿼리 실행 중에도
-- 호출된다(정책 표현식 안의 함수 호출) — EXECUTE는 절대 좁히지 않는다(아래 참고).
-- search_path 고정만 적용 — 함수 본문이 accounts 테이블 하나만, 그것도 public
-- 스키마 객체만 참조하므로 완전히 무해하다.
alter function is_platform_admin() set search_path = public;

-- ------------------------------------------------------------
-- EXECUTE 최소화 (PUBLIC/anon 회수, authenticated만 유지)
-- ------------------------------------------------------------
revoke all on function reserve_class(uuid, uuid) from public;
revoke all on function reserve_class(uuid, uuid) from anon;
grant execute on function reserve_class(uuid, uuid) to authenticated;

revoke all on function reserve_with_membership(uuid, uuid, uuid) from public;
revoke all on function reserve_with_membership(uuid, uuid, uuid) from anon;
grant execute on function reserve_with_membership(uuid, uuid, uuid) to authenticated;

revoke all on function cancel_reservation(uuid) from public;
revoke all on function cancel_reservation(uuid) from anon;
grant execute on function cancel_reservation(uuid) to authenticated;

revoke all on function refund_membership(uuid) from public;
revoke all on function refund_membership(uuid) from anon;
grant execute on function refund_membership(uuid) to authenticated;

revoke all on function fulfill_order(uuid) from public;
revoke all on function fulfill_order(uuid) from anon;
grant execute on function fulfill_order(uuid) to authenticated;

-- [2026-08-13 최종 교차검증에서 추가] usable_memberships/usable_memberships_for_classes:
-- anon-key로 안전한 프로브(존재하지 않는 UUID, 읽기 전용이라 애초에 부작용 없음)를
-- 직접 실행해 Live EXECUTE 상태를 실측 확인했다 — 둘 다 HTTP 200 + 빈 배열([])로
-- 응답, 즉 anon이 현재 이 함수를 실제로 호출할 수 있다(42501 아님). 다만 내부의
-- "m.profile_id in (select id from profiles where account_id = my_account_id())"
-- 필터가 anon(my_account_id() = null)에 대해 항상 0행을 반환시키므로 실제 데이터
-- 노출은 없다(reserve_class 등과 동일한 "이미 안전하지만 표면이 넓다" 케이스).
-- 추측이 아니라 실측을 근거로 authenticated로 좁힌다.
revoke all on function usable_memberships(uuid, uuid) from public;
revoke all on function usable_memberships(uuid, uuid) from anon;
grant execute on function usable_memberships(uuid, uuid) to authenticated;

revoke all on function usable_memberships_for_classes(uuid[], uuid) from public;
revoke all on function usable_memberships_for_classes(uuid[], uuid) from anon;
grant execute on function usable_memberships_for_classes(uuid[], uuid) to authenticated;

-- is_platform_admin(): EXECUTE 절대 변경하지 않음(위 설명 참고).

COMMIT;

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select routine_name, security_type
from information_schema.routines
where routine_name in (
    'reserve_class', 'reserve_with_membership', 'cancel_reservation',
    'refund_membership', 'fulfill_order', 'usable_memberships',
    'usable_memberships_for_classes', 'is_platform_admin'
);

select grantee, routine_name, privilege_type
from information_schema.routine_privileges
where routine_name in (
    'reserve_class', 'reserve_with_membership', 'cancel_reservation',
    'refund_membership', 'fulfill_order', 'usable_memberships',
    'usable_memberships_for_classes'
)
order by routine_name, grantee;

-- search_path hijack 가능성 최종 확인용 진단(참고용 — 이 배치 적용 여부와
-- 무관하게 언제든 실행 가능한 read-only 쿼리):
-- select has_schema_privilege('anon', 'public', 'create');
-- select has_schema_privilege('authenticated', 'public', 'create');
