-- ============================================================
-- P2-13: service_role에 contracts/notification_logs GRANT 추가(좁은 범위)
--
-- [배경] 두 테이블 모두 RLS는 이미 활성화돼 있고 정책은 0건(현재는 owner를 포함해
-- 아무도 접근 못 하는 완전 차단 상태, docs/21_RLS_Gap_Analysis.md 정정 참고) — 이건
-- 이번 파일이 건드리지 않는다(정책 추가는 Batch A2, 별도 승인 필요, 이번 배치 범위 밖).
--
-- 이 파일은 그것과 완전히 별개인 문제만 고친다: service_role 자체에 SQL GRANT가
-- 없어서(`account_center_permissions`/`products`에서 이미 겪은 것과 같은 종류의 문제,
-- RLS와 무관) service_role은 RLS를 우회하는 역할인데도 애초에 이 두 테이블에 접근할
-- 권한 자체가 없다. `contracts`(DELETE 정책이 의도적으로 없음 — 서명 후 불변)와
-- `notification_logs`(INSERT 정책이 의도적으로 없음 — 서버 트리거 전용)는 일반
-- client·admin client 어느 쪽으로도 지금은 fixture를 만들거나 지울 방법이 없어
-- 통합 테스트 자동화가 막혀 있었다.
--
-- [영향받는 기존 데이터] 없음(GRANT만, 정책/데이터 무변경). 두 테이블 다 현재
-- app/lib 코드 참조 0건(미사용 기능)이라 일반 사용자 접근 경로에는 영향 없음.
-- [위험도] 매우 낮음 — service_role은 애초에 RLS를 우회하는 관리용 역할이고, anon/
-- authenticated GRANT는 건드리지 않는다(그쪽은 여전히 RLS 정책 0건이라 완전 차단
-- 그대로 유지됨).
--
-- 여러 번 실행해도 안전.
-- ============================================================

grant select, insert, update, delete on contracts to service_role;
grant select, insert, update, delete on notification_logs to service_role;
