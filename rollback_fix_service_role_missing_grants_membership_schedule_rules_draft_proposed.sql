-- fix_service_role_missing_grants_membership_schedule_rules_draft_proposed.sql 롤백
revoke select, insert, update, delete on membership_schedule_rules from service_role;
