#!/usr/bin/env bash
# 일회용 로컬 Supabase 스택(project_id=mwhabit-isolated)을 "운영과 같은 함수 정의 상태"로 만든 뒤 PR #251/#252 SQL 을 적용한다.
# 운영·공유 DEV 로는 절대 연결하지 않는다: 이 스크립트는 `docker exec` 로 로컬 컨테이너 supabase_db_mwhabit-isolated 안의 psql 만 쓴다(DB 접속 문자열·비밀값 없음).
#
# 왜 이 순서인가: #251/#252 SQL 은 "적용 전 운영 정의 해시"가 아니면 덮어쓰지 않고 중단한다(안전장치). 격리 baseline 은 공유 DEV 덤프라 운영보다 앞/뒤가 달라서,
# 운영에 이미 적용된 NICEPAY 준비 SQL(P0~P2b, docs/payments/NICEPAY_SQL_RUNBOOK_20261028.md)을 같은 순서로 먼저 넣어 운영 정의와 해시를 맞춘다.
#   1) 운영에 이미 적용된 선행 SQL 7개 → 2) NICEPAY 센터 분리(P2)·게이트 심사관 판별(P2b) → 3) #251 fix_expired_fixed_date_products → 4) 운영 fulfill_order 정의(prodParity) → 5) #252 add_expired_order_resolution
# 시드: [QA] 심사 시험 스튜디오(승인 센터) — 시험이 상품·주문을 만들 센터. 어느 단계든 실패하면 즉시 중단한다(set -e, ON_ERROR_STOP).
set -euo pipefail
cd "$(dirname "$0")/../../.."

DB_CONTAINER="supabase_db_mwhabit-isolated"
# 가드 1: 일회용 로컬 스택이어야 한다(운영·공유 DEV·호스팅이면 여기서 중단). ISOLATED_* 는 scripts/isolated/stackEnv.mjs 가 내보낸다.
node scripts/ci/isolatedTargetGuard.mjs
# 가드 2: 이 이름의 로컬 컨테이너가 실제로 떠 있어야 한다(없으면 어떤 SQL 도 실행하지 않는다).
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then echo "ABORT: 로컬 격리 DB 컨테이너($DB_CONTAINER)가 없어요 — SQL 을 실행하지 않고 중단" >&2; exit 1; fi

psql_file() { docker exec -i "$DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q < "$1"; }
psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -At -c "$1"; }

ORDER=(
  scripts/isolated/nicepayReview/localOperatingCenterSeed.sql
  fix_refund_pg_origin_guard_20261017.sql
  fix_refund_server_path_fail_closed_20261017.sql
  fix_refund_amount_integrity_20261017.sql
  fix_orders_insert_role_guard_20261017.sql
  add_nicepay_checkout_gate_20261017.sql
  add_nicepay_provider_support_20261016.sql
  fix_create_order_secure_allow_nicepay_20261016.sql
  add_nicepay_review_center_isolation_20261028.sql
  fix_nicepay_gate_reviewer_flag_20261029.sql
  fix_expired_fixed_date_products_20261031.sql
  scripts/isolated/expiredOrder/prodParity_fulfill_order.sql
  add_expired_order_resolution_20261031.sql
)
for f in "${ORDER[@]}"; do echo "apply: $f"; psql_file "$f"; done

# 적용 결과 확인(운영 적용본과 같은 해시여야 한다 — 다르면 실패)
H=$(psql_q "select md5(pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure))")
[ "$H" = "935b66bebdd126ef7d36a80237036924" ] || { echo "ABORT: fulfill_order 해시 불일치($H)" >&2; exit 1; }
[ "$(psql_q "select count(*) from pg_proc where proname = 'manager_resolve_expired_order'")" = "1" ] || { echo "ABORT: manager_resolve_expired_order 없음" >&2; exit 1; }
echo "OK: 격리 스택이 운영 적용본과 같은 상태(fulfill_order 935b66be…, RPC 존재)"
