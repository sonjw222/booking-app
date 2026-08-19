-- add_manager_menu_permissions.sql 롤백
-- role_permissions/account_center_permissions는 permission_key FK가 on delete cascade라
-- 아래 delete로 함께 정리됨. facility.review.view/pass.order.view는 이 파일이 새로 만든
-- 게 아니라 원래 있던 항목이라 지우지 않는다.
delete from permissions where key in ('pass.goods.view', 'schedule.admin_assignment_log.view');
