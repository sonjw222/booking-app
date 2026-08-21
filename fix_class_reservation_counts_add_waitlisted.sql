-- ============================================================
-- P1-12: 운영설정 "그룹 수업 대기 인원 표시"(show_group_waitlist_count) 실제 연결
--
-- [배경] center_settings.show_group_waitlist_count는 스키마 정의만 있고 실제로 어디서도
-- 읽지 않는 죽은 설정이었다(회원 화면에 애초에 대기 인원 자체를 안 보여줬음). 확정 인원
-- 표시(show_group_reserved_count)는 이미 정상 동작하던 "그룹 수업 예약 인원 표시"와
-- 같은 패턴으로 연결한다.
--
-- class_reservation_counts 뷰(reservation_functions.sql:418-421)는 confirmed_count만
-- 노출했다 — 여기에 waitlisted_count를 추가한다. 이 뷰는 개인정보 없이 인원수만 노출하는
-- 용도(회원 RLS로는 남의 예약을 못 봄)라 waitlisted_count 추가도 같은 성격.
--
-- [영향받는 기존 데이터] 없음(뷰 재정의만, 기존 confirmed_count 컬럼은 그대로 유지).
-- [위험도] 낮음 — 뷰에 컬럼 추가만, 기존 쿼리(confirmed_count만 select하는 곳)는 영향 없음.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace view class_reservation_counts as
select
    class_id,
    count(*) filter (where status = 'confirmed')::int as confirmed_count,
    count(*) filter (where status = 'waitlisted')::int as waitlisted_count
from reservations
where status in ('confirmed', 'waitlisted')
group by class_id;

grant select on class_reservation_counts to authenticated;

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select column_name from information_schema.columns where table_name = 'class_reservation_counts';
