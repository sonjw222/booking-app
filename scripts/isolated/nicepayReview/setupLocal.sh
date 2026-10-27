#!/usr/bin/env bash
# 로컬 일회용 Supabase(isolated-supabase) 전용: 운영 센터 시드 → (선행)기간 RPC → 분리 SQL → 심사 센터 시드 → 페르소나 순으로 준비한다.
# 운영/공유 DEV 로는 실행되지 않는다(docker 컨테이너 이름 고정). 사용: ISO_ENV_FILE=<bootstrapEphemeral 가 쓴 파일> scripts/isolated/nicepayReview/setupLocal.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
PSQL() { docker exec -i supabase_db_mwhabit-isolated psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
set -a; . "${ISO_ENV_FILE:?ISO_ENV_FILE 필요}"; set +a
PSQL < scripts/isolated/nicepayReview/localOperatingCenterSeed.sql
PSQL < add_public_storefront_product_periods_20261027.sql >/dev/null
PSQL < add_nicepay_review_center_isolation_20261028.sql >/dev/null
PSQL < seed_nicepay_review_center_20261028.sql
PSQL -v ub="$TEST_USER_B_EMAIL" -v ua="$TEST_USER_A_EMAIL" -v ma="$TEST_MANAGER_A_EMAIL" -v mb="$TEST_MANAGER_B_EMAIL" < scripts/isolated/nicepayReview/localPersonas.sql
echo "setupLocal OK"
