-- ============================================================
-- P2-28 근본 수정 — 격리 테스트 센터 삭제를 하드코딩된 테이블 나열 대신
-- 실제 FK 그래프 전체를 반영한 함수 하나로 통합.
--
-- 배경: tests/integration/auto-book-membership-security.test.ts의
--   createIsolatedOwnedCenter()가 이전 실행이 남긴 격리 센터를 정리할 때, 그때그때
--   새로 발견되는 FK 위반을 하나씩 패치해왔다(payments_membership_id_fkey →
--   이번엔 center_members_center_id_fkey). information_schema로 centers를
--   직접/간접 참조하는 전체 FK 그래프를 조회해(2026-08-21) 실제로 존재하는 모든
--   경로를 한 번에 반영했다 — 이제 새 FK 위반이 또 나오면 이 함수만 갱신하면 된다
--   (테스트 파일 여러 곳을 다시 뒤질 필요 없음).
--
-- 안전장치: anon/authenticated에서 실행 권한을 명시적으로 회수하고 service_role에만
--   부여한다 — 테스트 코드는 SUPABASE_SERVICE_ROLE_KEY로 만든 admin 클라이언트로만
--   이 함수를 호출하므로(tests/integration/setup.ts의 getFixtureAdminClient()), 일반
--   로그인 사용자가 supabase.rpc()로 남의 센터를 통째로 지우는 경로가 생기지 않는다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전(멱등 — 대상
-- 행이 이미 없으면 그냥 0건 삭제).
-- ============================================================

create or replace function delete_test_center_cascade(p_center_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    -- ---- 1단계: centers를 간접 참조하는(hop-2) 테이블 중 NO ACTION인 것들 ----
    delete from point_transactions where payment_id in (select id from payments where center_id = p_center_id);
    delete from membership_transfers where membership_id in (select id from memberships where center_id = p_center_id);
    delete from product_passes
     where product_id in (select id from products where center_id = p_center_id)
        or linked_membership_id in (select id from memberships where center_id = p_center_id);
    delete from reservations
     where class_id in (select id from classes where center_id = p_center_id)
        or membership_id in (select id from memberships where center_id = p_center_id);
    delete from locker_assignments where locker_id in (select id from lockers where center_id = p_center_id);
    delete from community_comments where post_id in (select id from community_posts where center_id = p_center_id);
    delete from progress_records where category_id in (select id from progress_categories where center_id = p_center_id);

    -- ---- 2단계: centers를 직접 참조(hop-1)하면서, 다른 hop-1 테이블을 막는 것들 ----
    delete from admin_action_logs where center_id = p_center_id;   -- memberships를 막음
    delete from contracts where center_id = p_center_id;            -- memberships/contract_templates를 막음
    delete from payments where center_id = p_center_id;             -- memberships를 막음(point_transactions는 이미 정리됨)
    delete from classes where center_id = p_center_id;              -- class_types/rooms를 막음(reservations는 이미 정리됨)
    delete from memberships where center_id = p_center_id;          -- products를 막음(관련 자식 전부 이미 정리됨)
    delete from manager_centers where center_id = p_center_id;      -- center_roles를 막음
    delete from center_members where center_id = p_center_id;       -- member_grades를 막음
    delete from notification_logs where center_id = p_center_id;    -- notification_rules를 막음
    delete from reviews where center_id = p_center_id or target_center_id = p_center_id;

    -- ---- 3단계: 이제 막는 게 없어진 hop-1 테이블들 ----
    delete from products where center_id = p_center_id;
    delete from center_roles where center_id = p_center_id;
    delete from member_grades where center_id = p_center_id;
    delete from notification_rules where center_id = p_center_id;
    delete from class_types where center_id = p_center_id;
    delete from rooms where center_id = p_center_id;
    delete from contract_templates where center_id = p_center_id;
    delete from progress_categories where center_id = p_center_id;
    delete from lockers where center_id = p_center_id;
    delete from community_posts where center_id = p_center_id;
    delete from center_settings where center_id = p_center_id;
    delete from center_contacts where center_id = p_center_id;
    delete from center_holidays where center_id = p_center_id;
    delete from center_member_fields where center_id = p_center_id;
    delete from change_logs where center_id = p_center_id;
    delete from expenses where center_id = p_center_id;
    delete from leads where center_id = p_center_id;
    delete from messages where center_id = p_center_id;
    delete from popup_notices where center_id = p_center_id;
    delete from profile_center_fields where center_id = p_center_id;
    delete from schedule_templates where center_id = p_center_id;
    delete from staff_salaries where center_id = p_center_id;
    delete from staff_schedules where center_id = p_center_id;      -- schedule_memos는 CASCADE라 자동 정리
    delete from terms where center_id = p_center_id;

    -- ---- 4단계: 센터 자체. 남은 CASCADE 테이블(cart_items/center_announcements/
    -- center_reviews/inquiry_threads/orders/point_accounts/point_logs/purchase_requests)은
    -- 여기서 자동 삭제되고, notifications.center_id는 SET NULL로 자동 처리된다.
    delete from centers where id = p_center_id;
end;
$$;

revoke all on function delete_test_center_cascade(uuid) from public;
revoke all on function delete_test_center_cascade(uuid) from anon;
revoke all on function delete_test_center_cascade(uuid) from authenticated;
grant execute on function delete_test_center_cascade(uuid) to service_role;

-- ============================================================
-- 확인
-- ============================================================
select routine_name, security_type from information_schema.routines
 where routine_name = 'delete_test_center_cascade';
select grantee, privilege_type from information_schema.role_routine_grants
 where routine_name = 'delete_test_center_cascade';
