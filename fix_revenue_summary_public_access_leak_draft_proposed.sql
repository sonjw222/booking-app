-- ============================================================
-- P2-5 조사 중 발견된 확정 보안 문제 — revenue_summary view가 anon(비로그인)에게
-- 전체 센터 매출 데이터를 노출함. P0로 격상.
--
-- 확인된 사실 (read-only 진단, 2026-08-23):
--   1) information_schema.role_table_grants: anon/authenticated 모두 revenue_summary에
--      SELECT(및 그 외 CRUD류 권한 전부, 아마 스키마 생성 시 "GRANT ALL ON ALL TABLES IN
--      SCHEMA public" 같은 일괄 부여의 부수효과 — 이 view가 CRUD가 실제로 되는 건 아니지만
--      SELECT 권한이 문제)를 갖고 있음.
--   2) pg_class.reloptions가 null — 즉 security_invoker=true가 설정돼 있지 않다.
--      Postgres 기본 동작(PG15 이전 방식, 지금도 명시적으로 켜지 않으면 동일)에서 plain
--      view는 view owner(postgres)의 권한으로 실행돼 하위 테이블의 RLS를 건너뛴다.
--   3) revenue_summary가 select하는 payments 테이블의 실제 SELECT RLS(add_sales.sql
--      "매니저 매출 조회")는 그 센터 매니저로 좁혀져 있다 — 즉 view가 없었다면 절대 못 볼
--      데이터다.
--   → 결론: anon key(클라이언트 번들에 박혀있는 공개 키)만 있으면 로그인 없이 REST API로
--     `revenue_summary`를 직접 호출해 전체 센터의 일자별 결제건수·총매출·카드/현금/계좌이체/
--     포인트·미수금을 볼 수 있는 상태였다.
--   → P2-6 조사에서 별도로 이미 확인했듯 app/lib 어디서도 이 view를 쓰지 않는다 —
--     즉 정상 기능을 유지하며 취할 수 있는 가장 단순하고 안전한 조치는 anon/authenticated의
--     권한을 전부 회수하는 것이다(view 자체는 삭제하지 않음 — DROP은 CLAUDE.md 규칙 3
--     대상이라 별도 승인 필요, 이번엔 권한만 회수).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

revoke all on revenue_summary from anon, authenticated;

-- ============================================================
-- 확인 (아래 결과에 anon/authenticated 행이 하나도 없어야 정상)
-- ============================================================
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_name = 'revenue_summary'
 order by grantee, privilege_type;
