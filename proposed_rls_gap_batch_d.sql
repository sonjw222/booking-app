-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN ⚠️
-- RLS Gap Batch D — 미구현·레거시 후보
-- 대상: popup_notices, competitions, community_comments, change_logs
-- 짝 파일: rollback_rls_gap_batch_d.sql
-- 재사용 헬퍼: my_account_id(), my_managed_center_ids(), has_permission(), is_platform_admin()
--
-- 이 배치의 4개 테이블은 로드맵 포함 여부 자체가 아직 결정되지 않았습니다
-- (docs/TODO.md P3-4/P3-8). 정책 적용은 "포함하기로 결정될 경우 바로 쓸 수 있도록"
-- 준비해두는 것이며, 이 배치를 다른 배치보다 먼저 적용해야 할 급박함은 없습니다.
-- ============================================================


-- ------------------------------------------------------------
-- popup_notices — 조회는 전체 허용(공지 성격, PII 없음), 쓰기는 스코프별 분리.
--
-- [ACL-003 재검증 이후 강화] 원안은 center_id가 있는(센터 전용 공지) 경우 쓰기를
-- my_managed_center_ids()만으로 허용했다(과다 권한 패턴). 팝업공지는 자동 알림 설정과
-- topically 가까우므로 facility.notification 권한을 요구하도록 좁힌다.
-- ------------------------------------------------------------
alter table popup_notices enable row level security;

drop policy if exists "누구나 팝업공지 조회" on popup_notices;
create policy "누구나 팝업공지 조회"
    on popup_notices for select using (true);

drop policy if exists "팝업공지 생성" on popup_notices;
create policy "팝업공지 생성"
    on popup_notices for insert
    with check (
        (center_id is null and is_platform_admin())
        or (center_id is not null and has_permission(center_id, 'facility.notification'))
    );
drop policy if exists "팝업공지 수정" on popup_notices;
create policy "팝업공지 수정"
    on popup_notices for update
    using (
        (center_id is null and is_platform_admin())
        or (center_id is not null and has_permission(center_id, 'facility.notification'))
    )
    with check (
        (center_id is null and is_platform_admin())
        or (center_id is not null and has_permission(center_id, 'facility.notification'))
    );
drop policy if exists "팝업공지 삭제" on popup_notices;
create policy "팝업공지 삭제"
    on popup_notices for delete
    using (
        (center_id is null and is_platform_admin())
        or (center_id is not null and has_permission(center_id, 'facility.notification'))
    );


-- ------------------------------------------------------------
-- competitions — 전역 공개 정보(센터 무관). 조회는 전체 허용, 쓰기는 platform admin만
-- (카탈로그 그대로, 변경 없음 — 원래부터 센터 스코프가 없는 전역 데이터).
-- ------------------------------------------------------------
alter table competitions enable row level security;

drop policy if exists "누구나 대회정보 조회" on competitions;
create policy "누구나 대회정보 조회"
    on competitions for select using (true);

drop policy if exists "플랫폼 운영자 대회정보 관리" on competitions;
create policy "플랫폼 운영자 대회정보 관리"
    on competitions for all
    using (is_platform_admin())
    with check (is_platform_admin());


-- ------------------------------------------------------------
-- community_comments — 작성자 본인만 쓰기/수정/삭제(카탈로그 무관, 계정 소유권 기준
-- — 원안 그대로, 변경 없음). 부모 community_posts도 write 정책이 없어 별도 후속 이슈
-- 필요(docs/TODO.md P2-11에 이미 기록됨) — 이 배치에서 함께 처리하지 않음.
-- ------------------------------------------------------------
alter table community_comments enable row level security;

drop policy if exists "로그인 사용자 댓글 조회" on community_comments;
create policy "로그인 사용자 댓글 조회"
    on community_comments for select using (auth.role() = 'authenticated');

drop policy if exists "본인 댓글 작성" on community_comments;
create policy "본인 댓글 작성"
    on community_comments for insert
    with check (author_account_id = my_account_id());

drop policy if exists "본인 댓글 수정" on community_comments;
create policy "본인 댓글 수정"
    on community_comments for update
    using (author_account_id = my_account_id())
    with check (author_account_id = my_account_id());

drop policy if exists "본인 댓글 삭제" on community_comments;
create policy "본인 댓글 삭제"
    on community_comments for delete
    using (author_account_id = my_account_id());


-- ------------------------------------------------------------
-- change_logs — 감사로그. 조회만 허용, 쓰기는 서버(트리거/RPC) 전용.
--
-- [ACL-003 재검증 이후 강화] 원안은 my_managed_center_ids()만으로 조회를 허용했다
-- (과다 권한 패턴 — 이 로그는 회원/수강권 변경 diff를 담아 민감할 수 있음). 카탈로그에
-- "감사로그 조회" 전용 키가 없어, account_center_permissions 자체를 보호할 때 쓴 것과
-- 같은 "관리자급" 대리 키인 facility.role_permission으로 좁힌다.
-- ------------------------------------------------------------
alter table change_logs enable row level security;

drop policy if exists "센터 스태프 변경이력 조회" on change_logs;
create policy "권한 보유 스태프 변경이력 조회"
    on change_logs for select
    using (has_permission(center_id, 'facility.role_permission') or is_platform_admin());
-- INSERT/UPDATE/DELETE: 의도적으로 정책 없음 → 기본 거부 (서버 함수는 security definer로 우회)
