-- ============================================================
-- ROLLBACK for fix_staff_account_search_privacy_20261004.sql — 직전 Production 상태(2026-10-04 읽기 전용 pg_get_expr 기준)로 복원한다.
-- ⚠ 보안상 위험한 rollback: accounts "계정 조회" 정책이 다시 "어느 센터에서든 owner 또는 facility.staff.create 권한이면 accounts 전체 SELECT 가능"을 허용한다
--   (스태프 초대 전역 부분검색 노출이 다시 열린다). 새 웹(search_staff_candidates 호출)이 배포된 상태에서 rollback하면 스태프 추가 검색은 함수 없음 오류로 실패하므로 웹을 먼저 되돌리거나,
--   긴급 장애 대응으로만 사용하세요. 이 파일은 이 migration이 바꾼 것(정책 1개, RPC 1개, 시도 기록 테이블 1개)만 되돌린다.
-- ============================================================
begin;

drop function if exists public.search_staff_candidates(uuid, text);
drop table if exists public.staff_candidate_search_attempts;

drop policy if exists "계정 조회" on public.accounts;
create policy "계정 조회"
    on public.accounts for select
    using (((auth_id = auth.uid()) OR (id IN ( SELECT account_auth_identities.account_id
   FROM account_auth_identities
  WHERE (account_auth_identities.auth_id = auth.uid()))) OR (id IN ( SELECT mc.account_id
   FROM manager_centers mc
  WHERE (mc.center_id IN ( SELECT my_managed_center_ids() AS my_managed_center_ids)))) OR (id IN ( SELECT p.account_id
   FROM (profiles p
     JOIN center_members cm ON ((cm.profile_id = p.id)))
  WHERE (cm.center_id IN ( SELECT my_managed_center_ids() AS my_managed_center_ids)))) OR (EXISTS ( SELECT 1
   FROM (manager_centers mc
     JOIN center_roles r ON ((r.id = mc.role_id)))
  WHERE ((mc.account_id = my_account_id()) AND (mc.status = 'active'::text) AND ((r.is_owner = true) OR (EXISTS ( SELECT 1
           FROM role_permissions rp
          WHERE ((rp.role_id = r.id) AND (rp.permission_key = 'facility.staff.create'::text))))))))));

commit;
