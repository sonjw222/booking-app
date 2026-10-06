-- ============================================================
-- reservations 남은 broad ACL 최소화(2026-10-04). 앱 런타임 사용 근거로만 회수한다.
-- 선행: fix_reservation_integrity_20261003.sql(적용됨) + fix_reservations_privileges_minimize_20261003.sql(authenticated INSERT, anon/authenticated REFERENCES·TRIGGER 회수).
--       이번 파일은 그 두 파일이 다루지 않은 "authenticated DELETE"와 "anon SELECT"만 회수한다. 이미 회수된 권한은 다시 건드리지 않는다.
-- 근거(저장소 전수 검색):
--   · authenticated DELETE: app/·lib/에 reservations 직접 delete/upsert 없음. 예약 삭제는 전부 SECURITY DEFINER RPC(delete_class_safe / delete_class_group_safe / add_holiday_safe /
--     delete_test_center_cascade, owner 권한)와 service_role Edge Function(delete-account 등)에서만 일어난다. "매니저 취소예약 정리" DELETE 정책은 RPC 도입 전 수업 삭제용 경로였고
--     지금은 쓰는 클라이언트가 없다. 통합/E2E 테스트의 매니저 세션 raw delete(cleanupTestClass 등)는 service_role(getFixtureAdminClient) 정리로 바꿨다.
--   · anon SELECT: anon이 reservations를 읽는 화면/함수 없음(로그인 전 화면은 reservations를 조회하지 않고, 로그인 필요 조회는 getMyAccountId 가드 뒤에서만 일어난다).
--     RLS 정책도 anon에게 행을 주지 않아 실제 노출은 이미 0이었고, 이번 회수는 "정책이 실수로 추가돼도 열리지 않게" 테이블 권한 자체를 제거한다.
--     공개 예약 인원수는 owner 권한 view class_reservation_counts가 제공하므로 이 권한과 무관(view는 owner 권한으로 reservations를 읽는다).
--     (알려진 영향: 세션이 만료된 호출은 "빈 결과" 대신 "permission denied" 오류가 된다 — 앱 조회는 로그인 상태에서만 호출됨.)
-- 유지: authenticated SELECT(마이페이지/예약 화면, RLS로 본인/내 센터만), authenticated member_memo 컬럼 UPDATE, service_role 전체(SELECT/INSERT/UPDATE/DELETE),
--       owner/SECURITY DEFINER 함수·트리거 권한, RLS enable 및 정책 4개(DELETE 정책도 지우지 않는다 — 권한이 없으면 사실상 비활성이고 rollback이 단순하다).
-- 이 세션에서는 production에 실행하지 않았습니다. 적용 전 verify_reservations_privileges_minimize_20261003.sql을 먼저 실행해 직전 migration 상태를 확인하세요
--   (그 verify는 DELETE/anon SELECT '유지'를 검사하므로 이 파일 적용 후에는 NOT_APPLIED가 나온다 — 이후에는 verify_reservations_remaining_privileges_20261004.sql을 쓴다).
-- ============================================================
begin;

revoke delete on table public.reservations from authenticated;
revoke select on table public.reservations from anon;

commit;
