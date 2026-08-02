-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless proposed_rls_gap_batch_c.sql was applied ⚠️
-- Batch C rollback — 원래(RLS 없음) 상태로 되돌립니다.
-- ------------------------------------------------------------
-- 순서 주의: locker_assignments가 lockers를 참조하므로, disable 순서 자체는
-- FK와 무관(RLS는 FK와 별개)하지만 정책 삭제는 아래 순서를 그대로 따르세요.
-- ============================================================

drop policy if exists "본인 또는 권한 보유 스태프 락커배정 조회" on locker_assignments;
drop policy if exists "권한 보유 스태프 락커배정 생성" on locker_assignments;
drop policy if exists "권한 보유 스태프 락커배정 수정" on locker_assignments;
drop policy if exists "권한 보유 스태프 락커배정 삭제" on locker_assignments;
alter table locker_assignments disable row level security;

drop policy if exists "로그인 사용자 락커 조회" on lockers;
drop policy if exists "권한 보유 스태프 락커 생성" on lockers;
drop policy if exists "권한 보유 스태프 락커 수정" on lockers;
drop policy if exists "권한 보유 스태프 락커 삭제" on lockers;
alter table lockers disable row level security;

drop policy if exists "당사자 또는 권한 보유 스태프 양도이력 조회" on membership_transfers;
alter table membership_transfers disable row level security;

drop policy if exists "로그인 사용자 수업구분 조회" on class_types;
drop policy if exists "권한 보유 스태프 수업구분 생성" on class_types;
drop policy if exists "권한 보유 스태프 수업구분 수정" on class_types;
drop policy if exists "권한 보유 스태프 수업구분 삭제" on class_types;
alter table class_types disable row level security;
