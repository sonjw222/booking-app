-- ============================================================
-- service_role GRANT 전체 감사 및 일괄 수정
--
-- 배경(2026-09-13, "예약 취소 완전 불가" RLS 수정(fix_classes_rls_permission_bypass.sql)
-- 검증 스크립트가 service_role로 role_permissions/class_trainers에 직접 쓰려다
-- "permission denied"로 막혀서 발견): 이 저장소에서 "새 테이블을 만들 때 service_role
-- GRANT를 빠뜨리는" 패턴이 지금까지 최소 6차례(notifications, account_auth_identities,
-- center_reviews, review_reports, 그리고 이번에 발견한 role_permissions/
-- class_trainers) 개별적으로 재발했다. 매번 하나씩 터질 때마다 고치는 대신, 이번에
-- public 스키마 전체 테이블/뷰를 대상으로 감사해서 한 번에 정리한다.
--
-- 확인 방법: information_schema.role_table_grants에서 grantee='service_role'인
-- 행이 하나도 없거나 SELECT/INSERT/UPDATE/DELETE 중 일부만 있는 테이블을 전수 조사.
-- 결과: 47개 테이블이 service_role GRANT가 전혀 없었고, 4개 테이블은 일부만 있었으며,
-- 뷰 3개(class_reservation_counts, product_sale_counts, revenue_summary)도
-- service_role SELECT가 없었다.
--
-- 안전성: service_role은 Postgres 역할 속성 자체가 rolbypassrls=true(직접 확인함)라
-- RLS 정책과 무관하게 이미 모든 행에 접근 가능하다 — 이 GRANT는 RLS를 우회해서 "새로
-- 열어주는" 권한이 아니라, "테이블에 접근은 가능한데 앞단 GRANT 체크에 막혀 조용히
-- permission denied가 나는" 배관 문제를 없애는 것뿐이다. service_role 키는 클라이언트에
-- 절대 노출되지 않고 서버/Edge Function/관리 스크립트에서만 쓰이므로, 이미 전체 신뢰
-- 대상인 이 역할에 테이블 레벨 CRUD를 여는 것은 추가 공격 표면이 아니다. anon/
-- authenticated 권한과 기존 RLS 정책은 이 파일에서 전혀 건드리지 않는다.
--
-- [영향받는 기존 데이터] 없음 — GRANT 추가만, 기존 행 변경 없음.
-- [위험도] 낮음 — service_role은 이미 RLS 우회 상태라 실질적인 접근범위 변화 없음,
-- 순수히 지금까지 막혀 있던(향후 Edge Function 등에서 터질 수 있었던) 경로만 열어줌.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- service_role GRANT가 전혀 없던 테이블 47개
-- ------------------------------------------------------------
grant select, insert, update, delete on account_auth_identities to service_role;
grant select, insert, update, delete on account_center_permissions to service_role;
grant select, insert, update, delete on account_link_requests to service_role;
grant select, insert, update, delete on alimtalk_templates to service_role;
grant select, insert, update, delete on cart_items to service_role;
grant select, insert, update, delete on center_announcements to service_role;
grant select, insert, update, delete on center_contacts to service_role;
grant select, insert, update, delete on center_member_fields to service_role;
grant select, insert, update, delete on change_logs to service_role;
grant select, insert, update, delete on chat_messages to service_role;
grant select, insert, update, delete on class_trainers to service_role;
grant select, insert, update, delete on class_types to service_role;
grant select, insert, update, delete on community_comments to service_role;
grant select, insert, update, delete on community_posts to service_role;
grant select, insert, update, delete on competitions to service_role;
grant select, insert, update, delete on contract_templates to service_role;
grant select, insert, update, delete on expenses to service_role;
grant select, insert, update, delete on home_banners to service_role;
grant select, insert, update, delete on inquiry_messages to service_role;
grant select, insert, update, delete on inquiry_threads to service_role;
grant select, insert, update, delete on leads to service_role;
grant select, insert, update, delete on locker_assignments to service_role;
grant select, insert, update, delete on lockers to service_role;
grant select, insert, update, delete on marketing_messages to service_role;
grant select, insert, update, delete on member_center_colors to service_role;
grant select, insert, update, delete on member_grades to service_role;
grant select, insert, update, delete on member_memos to service_role;
grant select, insert, update, delete on membership_session_amounts to service_role;
grant select, insert, update, delete on membership_transfers to service_role;
grant select, insert, update, delete on notification_rules to service_role;
grant select, insert, update, delete on permissions to service_role;
grant select, insert, update, delete on point_accounts to service_role;
grant select, insert, update, delete on point_logs to service_role;
grant select, insert, update, delete on popup_notices to service_role;
grant select, insert, update, delete on product_passes to service_role;
grant select, insert, update, delete on profile_center_fields to service_role;
grant select, insert, update, delete on progress_categories to service_role;
grant select, insert, update, delete on progress_records to service_role;
grant select, insert, update, delete on purchase_requests to service_role;
grant select, insert, update, delete on reviews to service_role;
grant select, insert, update, delete on role_permissions to service_role;
grant select, insert, update, delete on schedule_memos to service_role;
grant select, insert, update, delete on schedule_templates to service_role;
grant select, insert, update, delete on service_categories to service_role;
grant select, insert, update, delete on staff_salaries to service_role;
grant select, insert, update, delete on staff_schedules to service_role;
grant select, insert, update, delete on terms to service_role;

-- ------------------------------------------------------------
-- 일부 권한만 없던 테이블 4개 (모자란 것만 추가)
-- ------------------------------------------------------------
grant insert, update on admin_action_logs to service_role;
grant delete on messages to service_role;
grant delete on notifications to service_role;
grant delete on phone_verifications to service_role;

-- ------------------------------------------------------------
-- service_role SELECT가 없던 뷰 3개
-- ------------------------------------------------------------
grant select on class_reservation_counts to service_role;
grant select on product_sale_counts to service_role;
grant select on revenue_summary to service_role;

-- ============================================================
-- 확인 — 아무 행도 안 나와야 정상(빠진 게 없다는 뜻)
-- ============================================================
select t.tablename,
       bool_or(g.privilege_type = 'SELECT') as has_select,
       bool_or(g.privilege_type = 'INSERT') as has_insert,
       bool_or(g.privilege_type = 'UPDATE') as has_update,
       bool_or(g.privilege_type = 'DELETE') as has_delete
from pg_tables t
left join information_schema.role_table_grants g
       on g.table_name = t.tablename and g.grantee = 'service_role'
where t.schemaname = 'public'
group by t.tablename
having not (bool_or(g.privilege_type = 'SELECT')
        and bool_or(g.privilege_type = 'INSERT')
        and bool_or(g.privilege_type = 'UPDATE')
        and bool_or(g.privilege_type = 'DELETE'))
order by t.tablename;
