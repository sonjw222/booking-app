#!/usr/bin/env bash
# 로컬 격리 스택 전용(setupLocal.sh + setupExtraPersonas.mjs 이후): 실제 센터 허용 목록 SQL 과 "실센터 모사" 시험 데이터를 준비한다. 운영/공유 DEV 로는 실행되지 않는다(docker 컨테이너 이름 고정).
# 순서: 만료 상품 숨김(운영 적용 예정 SQL — 로컬을 같은 조건으로) → 허용 목록 SQL → 시험 데이터. 사용: ISO_ENV_FILE=… scripts/isolated/nicepayReview/setupRealCenter.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
PSQL() { docker exec -i "${ISO_DB_CONTAINER:-supabase_db_mwhabit-isolated}" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
: "${ISO_ENV_FILE:?ISO_ENV_FILE 필요}"
[ "${SKIP_EXPIRED_SQL:-}" = "1" ] || PSQL < fix_expired_fixed_date_products_20261031.sql >/dev/null
PSQL < add_nicepay_review_real_center_grants_20261103.sql >/dev/null
PSQL < scripts/isolated/nicepayReview/localRealCenterFixture.sql >/dev/null
echo "setupRealCenter OK"
