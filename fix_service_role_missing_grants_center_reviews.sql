-- ============================================================
-- center_reviews 테이블 service_role GRANT 누락 수정
--
-- 배경: review_reports 통합 테스트(tests/integration/review-reports.test.ts)의 fixture
-- 준비 단계에서 service_role(admin) 클라이언트로 center_reviews에 테스트용 후기 행을
-- 넣으려다 "permission denied for table center_reviews"로 실패해 발견함. 확인해보니
-- authenticated/postgres에는 GRANT가 있지만 service_role에는 전혀 없었음 — 이 저장소에서
-- 이미 여러 차례(notifications, account_auth_identities 등) 반복된 "새 테이블에
-- service_role GRANT 추가를 빠뜨림" 패턴과 동일.
--
-- 현재 이 테이블을 service_role로 쓰는 운영 코드(Edge Function/cron)는 없어서 당장
-- 사용자에게 보이는 장애는 아니지만, 향후 자동화(예: 신고 누적 시 후기 자동 조치,
-- 통계 배치 등)가 생기면 같은 문제를 또 겪게 되므로 지금 방어적으로 고쳐둔다.
--
-- 이 GRANT는 기존 center_reviews RLS 정책 6개(본인 작성/수정/삭제, 공개 조회, 매니저
-- 삭제/답변)나 anon/authenticated 권한에 전혀 영향을 주지 않는다 — service_role은
-- Postgres 역할 속성 자체가 rolbypassrls=true(직접 확인함)라 RLS 정책과 무관하게
-- 항상 우회하고, GRANT는 그 역할이 테이블에 "접근"할 수 있는지만 결정하는 별개
-- 레이어다. anon/authenticated는 이미 가진 권한 그대로 유지되고 기존 정책도 전혀
-- 안 건드린다 — 딱 service_role의 테이블 레벨 접근 권한 하나만 추가하는 것.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

grant select, insert, update, delete on center_reviews to service_role;

-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select grantee, privilege_type
from information_schema.role_table_grants
where table_name = 'center_reviews' and grantee = 'service_role'
order by privilege_type;
