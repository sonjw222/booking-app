-- ============================================================
-- Batch D (2026-10-03) — reservations 테이블 권한 최소화(예약 무결성 SQL 이후 남은 항목). 먼저 "실제로 필요한 권한"을 증거로 정했다.
-- 현재(예약 무결성 SQL 적용 후 Production): authenticated = SELECT, INSERT, DELETE, REFERENCES, TRIGGER + member_memo 컬럼 UPDATE / anon = SELECT, REFERENCES, TRIGGER / service_role = SELECT, INSERT, UPDATE, DELETE.
-- 클라이언트 사용 경로(app/, lib/ 전수 검색): 직접 SELECT(여러 화면) / 직접 UPDATE는 lib/mypage.ts의 member_memo 하나 / 직접 INSERT·DELETE·upsert 없음 / realtime publication 없음.
--   예약 생성·취소·대기승격·관리자 배정은 전부 SECURITY DEFINER RPC·트리거(owner 권한, 호출자의 테이블 권한에 의존하지 않음). 비-DEFINER 함수 중 reservations를 INSERT/DELETE하는 것 없음(Production 조회).
-- 회수(증명된 것만):
--   · authenticated INSERT: 앱/RPC가 필요로 하지 않고, 어차피 INSERT RLS 정책이 없어 거부되던 권한 — 정책이 실수로 추가돼도 열리지 않게 권한 자체를 제거. 통합테스트의 직접 INSERT는 service_role.
--   · anon/authenticated REFERENCES, TRIGGER: DDL(외래키/트리거 생성) 전용 권한이다. FK 검증과 트리거 실행은 테이블 owner 권한으로 일어나 호출자 권한이 필요 없고, PostgREST는 DDL을 하지 않는다 → 실사용 없음.
-- 유지(이유):
--   · authenticated SELECT: 마이페이지/예약 화면이 직접 조회(RLS: 내 프로필/내 센터 관리자만) — 필수.
--   · authenticated member_memo UPDATE: 앱의 유일한 직접 UPDATE(이미 적용됨).
--   · authenticated DELETE: "매니저 취소예약 정리" RLS 정책(cancelled/no_show 행만, 내 센터)이 의도한 경로이고 통합테스트 정리가 사용 — 앱 UI는 쓰지 않지만 정책이 행 범위를 제한하므로 이번에는 회수하지 않는다(별도 제품 결정).
--   · anon SELECT: RLS가 anon에게 행을 주지 않아 실제 노출은 없다. 세션 만료 시 조회가 "빈 결과"에서 "권한 오류"로 바뀌는 회귀 위험이 있어 이번에는 유지한다. 공개 예약 인원 수는 view class_reservation_counts(owner 권한)가 제공하므로 이 권한과 무관.
--   · service_role: 전혀 변경하지 않음. postgres/owner 권한도 변경 없음 → SECURITY DEFINER 함수·트리거 정상.
-- RLS 정책은 하나도 바꾸지 않는다(권한(GRANT)과 RLS는 별개: 정책 4개 그대로). 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================
begin;

revoke insert on table public.reservations from authenticated;
revoke references, trigger on table public.reservations from anon, authenticated;

commit;
