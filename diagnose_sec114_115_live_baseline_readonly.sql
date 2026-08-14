-- ============================================================
-- SEC-114/SEC-115 적용 전 필수 사전 확인 — 100% READ-ONLY.
--
-- fix_auto_book_membership_idor_draft_proposed.sql과
-- fix_manager_set_attendance_membership_integrity_draft_proposed.sql은 둘 다
-- CREATE OR REPLACE FUNCTION이다 — Git에서 제가 "현재 Live"라고 가정한 버전
-- (auto_book_membership: fix_auto_book_oneperday.sql, manager_set_attendance:
-- fix_attendance_consolidate_and_guard_draft_proposed.sql)과 실제 Live 본문이
-- 다르면, 제 CREATE OR REPLACE가 Live에만 있는 기능을 인지하지 못한 채
-- 덮어써버릴 위험이 있다(docs/DATABASE.md 12-5절 — 이 두 함수 모두 "여러
-- migration에서 create or replace됨" 목록에 실제로 포함돼 있음).
--
-- 아래 결과를 이 세션에 다시 붙여넣어주시면, 제가 가정한 baseline과 diff해서
-- 다르면 다르다고, 같으면 같다고 확정 보고하겠습니다. SQL은 실행하지 않습니다.
-- ============================================================

select pg_get_functiondef('auto_book_membership(uuid)'::regprocedure);
select pg_get_functiondef('manager_set_attendance(uuid, text)'::regprocedure);

-- 참고용 — 현재 EXECUTE grant 상태(수정 전 baseline 재확인)
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_name in ('auto_book_membership', 'manager_set_attendance')
order by routine_name, grantee;
