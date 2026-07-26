-- ============================================================
-- 회원 예약 개인 메모
--
-- 하는 일:
--   1) reservations 에 member_memo 컬럼 추가 (회원 본인 메모)
--   2) 본인 예약을 수정할 수 있는 정책 추가 (메모 저장용)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

alter table reservations add column if not exists member_memo text;

drop policy if exists "본인 예약 메모 수정" on reservations;
create policy "본인 예약 메모 수정"
    on reservations for update
    using (profile_id in (select my_profile_ids()))
    with check (profile_id in (select my_profile_ids()));


-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns
where table_name = 'reservations' and column_name = 'member_memo';


-- ============================================================
-- 완료!
--   → 마이페이지 → 예약내역 옆 📅 → 예약 캘린더
--   → 날짜 클릭 → 그날 수업 + 메모 입력
-- ============================================================
