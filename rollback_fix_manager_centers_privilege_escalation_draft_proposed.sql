-- ============================================================
-- fix_manager_centers_privilege_escalation_draft_proposed.sql 롤백
--
-- SEC-101 + SEC-112 수정 이전(Live 2026-08-12 스냅샷 확인) 상태로 3개 정책을 되돌린다.
-- ⚠ 이 롤백은 SEC-101/SEC-112 취약점 둘 다 그대로 복원한다 — 회귀 테스트가 실제로 이
-- 수정 때문에 실패하는 것으로 확인된 경우에만, 그리고 그 실패의 근본 원인을 먼저
-- 규명한 뒤에만 사용할 것. 원인 파악 없이 이 롤백부터 실행하지 말 것.
--
-- 여러 번 실행해도 안전.
-- [2026-08-13 최종 교차검증에서 추가] fix 파일과 동일한 이유로 BEGIN/COMMIT 추가
-- (정책 정의는 무변경) — 롤백 도중 부분 실패로 "일부만 되돌아간" 상태가 남는 것을 방지.
-- ============================================================

BEGIN;

drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (account_id = my_account_id());

drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (has_permission(center_id, 'facility.staff.create'));

drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (
        (account_id = my_account_id())
        or has_permission(center_id, 'facility.staff.update')
    )
    with check (
        (account_id = my_account_id())
        or has_permission(center_id, 'facility.staff.update')
    );

COMMIT;

-- ============================================================
-- 완료. 3개 정책 모두 이번 배치 적용 전 조건으로 정확히 복원됨.
-- ============================================================
