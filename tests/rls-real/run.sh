#!/usr/bin/env bash
# 격리 RLS 검증 인프라: 저장소의 실제 SQL(schema.sql + 마이그레이션)로 로컬 PostgreSQL 16을 만들고 PostgREST(JWT 역할 anon/authenticated)를 띄운다.
# 운영/공유 DEV 접속 없음. 사용: tests/rls-real/run.sh up|down   (Docker/Colima 필요)
set -euo pipefail
cd "$(dirname "$0")"; ROOT="$(cd ../.. && pwd)"
case "${1:-}" in
  up)
    docker network create qa-rls-net >/dev/null 2>&1 || true
    docker rm -f qa-rls-pg qa-rls-rest >/dev/null 2>&1 || true
    docker run -d --name qa-rls-pg --network qa-rls-net -e POSTGRES_PASSWORD=qa_local_only -e POSTGRES_DB=qa -p 127.0.0.1:55433:5432 postgres:16-alpine >/dev/null
    until docker exec qa-rls-pg pg_isready -U postgres -d qa >/dev/null 2>&1; do sleep 1; done; sleep 3
    docker exec -i qa-rls-pg psql -v ON_ERROR_STOP=1 -U postgres -d qa < 00_roles.sql >/dev/null
    # 적용 순서(저장소 SQL 그대로). usable_memberships_for_classes는 반환 타입이 바뀐 이력이 있어 최종본 적용 전에 drop.
    for f in schema.sql reservation_functions.sql add_account_linking.sql fix_my_account_id_merged_into_priority.sql add_sales.sql \
             add_class_trainers_pass_selection_mode_draft_proposed.sql add_pass_binding.sql fix_usable_memberships_shared.sql fix_usable_memberships_product_kind.sql; do
      docker exec -i qa-rls-pg psql -U postgres -d qa < "$ROOT/$f" >/dev/null 2>&1 || true
    done
    docker exec qa-rls-pg psql -U postgres -d qa -c "drop function if exists usable_memberships_for_classes(uuid[], uuid)" >/dev/null
    for f in add_orders.sql add_order_self_cancel.sql fix_permission_inquiries_orders.sql fix_profile_delete_soft_delete.sql add_admin_assignment.sql fix_reservation_cancel_source_column_draft_proposed.sql add_weekday_time_fixed_memberships.sql add_product_expiry_options.sql add_rolling_month_product_expiry.sql fix_customer_member_pass_detail_full_wiring.sql \
             add_payments_service_sale_type.sql add_manager_grant_product_rpc.sql fix_grant_schedule_and_kst_dates_20261003.sql add_class_cancel_lock.sql fix_calc_deadline_open_kind_draft_proposed.sql fix_reservation_integrity_20261003.sql add_membership_visibility_and_coupons.sql add_product_coupon_eligibility.sql fix_orders_amount_server_verification.sql fix_order_issuance_and_auto_booking.sql add_my_member_coupons_rpc_20261022.sql add_product_extras.sql \
             fix_centers_manager_centers_recursion_draft_proposed.sql add_product_group_label.sql add_product_sale_limit.sql add_selectable_count_pricing.sql \
             add_public_storefront_products.sql add_internal_qa_center_flag.sql add_reviews_points.sql fix_center_reviews.sql add_review_reply.sql add_point_ledger_unification.sql fix_center_limit_settings_normalize_20261022.sql add_profile_fields.sql add_customer_memo_feature.sql add_customer_member_phone_masking.sql fix_customer_member_phone_masking_center_scope.sql add_member_dormant.sql add_membership_expiry_extension.sql add_payments_unpaid_link.sql add_notifications.sql add_notification_triggers.sql; do
      docker exec -i qa-rls-pg psql -U postgres -d qa < "$ROOT/$f" >/dev/null 2>&1 || true
    done
    docker exec -i qa-rls-pg psql -v ON_ERROR_STOP=1 -U postgres -d qa < 05_shims.sql >/dev/null
    for f in add_class_goods_option.sql add_reservation_goods_usage.sql add_auto_booking.sql add_unplaced_passes.sql add_payment_test_provider.sql add_direct_payment.sql add_confirm_real_payment.sql fix_pg_payment_lifecycle.sql fix_order_issuance_and_auto_booking.sql fix_class_reservation_counts_add_waitlisted.sql add_class_trainer_names_rpc_draft_proposed.sql; do
      docker exec -i qa-rls-pg psql -U postgres -d qa < "$ROOT/$f" >/dev/null 2>&1 || true
    done
    docker exec -i qa-rls-pg psql -v ON_ERROR_STOP=1 -U postgres -d qa < 10_seed.sql >/dev/null
    docker run -d --name qa-rls-rest --network qa-rls-net -p 127.0.0.1:3203:3000 -e PGRST_DB_URI="postgres://authenticator:qa_authenticator@qa-rls-pg:5432/qa" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="qa-secret-qa-secret-qa-secret-1234567890" postgrest/postgrest:v12.2.3 >/dev/null
    for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:3203/ && break; sleep 1; done
    echo ok ;;
  down) docker rm -f qa-rls-pg qa-rls-rest >/dev/null 2>&1 || true; docker network rm qa-rls-net >/dev/null 2>&1 || true ;;
  ui-seed) docker exec -i qa-rls-pg psql -v ON_ERROR_STOP=1 -U postgres -d qa < 20_members_ui.sql >/dev/null; echo seeded ;;
  psql) shift; docker exec -i qa-rls-pg psql -U postgres -d qa "$@" ;;
  *) echo "usage: run.sh up|down|psql"; exit 1 ;;
esac
