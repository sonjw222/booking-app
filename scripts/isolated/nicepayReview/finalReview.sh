#!/usr/bin/env bash
# 로컬 일회용 Supabase(컨테이너 supabase_db_mwhabit-isolated 고정) 전용 — NICEPAY_SQL_FINAL_REVIEW.md 의 §4-5(원자성·멱등)·§6(롤백·종료) 증거를 만든다.
# 시작 전제: 운영과 같은 NICEPAY 기반 SQL 적용 + 운영 센터 시드 + (분리 SQL 은 있어도 되고 없어도 됨). 사용: scripts/isolated/nicepayReview/finalReview.sh <출력 디렉터리>
set -uo pipefail
cd "$(dirname "$0")/../../.."
OUT=${1:?출력 디렉터리 필요}; mkdir -p "$OUT"; TMP=$(mktemp -d)
PQ() { docker exec -i supabase_db_mwhabit-isolated psql -U postgres -At "$@"; }
q() { echo "$1" | PQ -q | tail -1; }
snap() { q "select md5(pg_get_functiondef('center_rows_visible(uuid)'::regprocedure))||' '||md5(pg_get_functiondef('fetch_public_storefront_products(uuid)'::regprocedure))||' '||md5(pg_get_functiondef('fetch_purchasable_products(uuid)'::regprocedure))||' '||md5(pg_get_functiondef('orders_guard_nicepay_create()'::regprocedure))||' '||md5(pg_get_functiondef('nicepay_claim_order(uuid)'::regprocedure))"; }
resid() { q "select (select count(*) from information_schema.columns where column_name in ('is_nicepay_review','nicepay_review_access'))||'/'||(select count(*) from pg_proc where proname in ('nicepay_is_reviewer','nicepay_review_center_allowed','nicepay_review_center_member_allowed','nicepay_class_has_my_reservation','nicepay_review_guard_center','enforce_center_nicepay_review_admin_only','enforce_nicepay_review_access_admin_only','nicepay_is_client_request'))||'/'||(select count(*) from pg_trigger where not tgisinternal and tgname ~ '^trg_(centers|accounts|orders|memberships|cart_items|purchase_requests|reservations)_nicepay_review_')||'/'||(select count(*) from pg_policies where policyname in ('nicepay_review_isolation','nicepay_own_reservation_class'))"; }
anon() { echo "begin; set local role anon; select (select count(*) from centers where is_nicepay_review)||'/'||(select count(*) from products where center_id in (select id from centers where is_nicepay_review))||'/'||(select count(*) from classes where center_id in (select id from centers where is_nicepay_review)); rollback;" | PQ -q | grep -E '^[0-9]+/'; }
DATA="select md5(string_agg(x,'|' order by x)) from (select 'c:'||id||name||status||is_internal x from centers where not is_nicepay_review union all select 'p:'||p.id||p.name||p.price from products p join centers c on c.id=p.center_id where not c.is_nicepay_review union all select 'cl:'||cl.id||cl.title from classes cl join centers c on c.id=cl.center_id where not c.is_nicepay_review union all select 'o:'||id||status||amount from orders where center_id is null or center_id not in (select id from centers where is_nicepay_review) union all select 'm:'||id||status from memberships union all select 'r:'||id||status from reservations union all select 'a:'||id||is_member||is_manager||is_platform_admin||pg_checkout_override from accounts union all select 'mc:'||id||status from manager_centers) s"
{
echo "=== 1. 원자성·멱등 (psql 을 ON_ERROR_STOP 없이 실행 — 편집기처럼 끝까지 흘려보내는 방식) ==="
# 깨끗한 시작: 이미 적용돼 있으면 P2b → P2 롤백(심사 센터가 있으면 먼저 닫는다)
q "update centers set is_internal=true where is_nicepay_review" >/dev/null 2>&1
PQ < rollback_fix_nicepay_gate_reviewer_flag_20261029.sql >/dev/null 2>&1; PQ < rollback_add_nicepay_review_center_isolation_20261028.sql >/dev/null 2>&1
q "drop trigger if exists trg_accounts_nicepay_review_access_admin_only on accounts" >/dev/null 2>&1   # 데이터 보존용으로 남는 보호 트리거도 지워 완전한 "적용 전" 상태에서 시작
q "alter table accounts drop column if exists nicepay_review_access" >/dev/null 2>&1   # 로컬 시험용: "P2 적용 전(컬럼 없음)" 상태를 만든다(롤백은 데이터 보존을 위해 컬럼을 남기므로)
BASE=$(snap); R0=$(resid); echo "[기준] 기존 함수 5개 정의 해시 기록. 잔여물(컬럼/함수/트리거/정책) = $R0 — 컬럼 1(is_nicepay_review: 롤백이 데이터 보존용으로 남김)·함수 1(accounts 보호 함수: 같은 이유로 남김)이 기준값"
python3 - "$TMP" <<'PY'
import sys
s=open('add_nicepay_review_center_isolation_20261028.sql').read(); T=sys.argv[1]+'/'
mid=s.index("create or replace function nicepay_review_guard_center()")
open(T+'p2_fail_mid.sql','w').write(s[:mid]+"select 1/0;\n"+s[mid:])
open(T+'p2_fail_late.sql','w').write(s.rstrip()[:-len('COMMIT;')]+"select 1/0;\nCOMMIT;\n")
p=open('fix_nicepay_gate_reviewer_flag_20261029.sql').read()
open(T+'p2b_fail_second.sql','w').write(p.replace("'public.nicepay_claim_order(uuid)'","'public.nicepay_claim_order_nonexistent(uuid)'"))
PY
# 컬럼 2개는 이전 단계에서 남아 있을 수 있으므로 "함수/트리거/정책 잔여물"만 원자성 판정에 쓴다
for v in mid late; do PQ < $TMP/p2_fail_$v.sql > $TMP/out_$v.txt 2>&1; echo "[T1 P2 실패 주입:$v] ERROR $(grep -c ERROR $TMP/out_$v.txt)회 → 잔여물 $(resid) / 기준($R0)과 동일: $([ "$(resid)" = "$R0" ] && echo YES || echo NO) / 기존 함수 정의 해시 동일: $([ "$(snap)" = "$BASE" ] && echo YES || echo NO)"; done
echo "[T2 P2b 를 P2 없이 실행] $(PQ < fix_nicepay_gate_reviewer_flag_20261029.sql 2>&1 | grep -m1 -o 'nicepay_review_access 가 없어요[^"]*' | cut -c1-80) → 기존 함수 정의 해시 동일: $([ "$(snap)" = "$BASE" ] && echo YES || echo NO)"
PQ < add_nicepay_review_center_isolation_20261028.sql > $TMP/out_ok.txt 2>&1; echo "[T3 P2 정상 적용] ERROR $(grep -c ERROR $TMP/out_ok.txt)회, 잔여물 $(resid) (기대 2/8/12/4)"
echo "[T3 검증 SQL 1번 쿼리]"; PQ -x < verify_add_nicepay_review_center_isolation_20261028.sql | sed -n 1,8p | sed 's/^/   /'
B2=$(snap); PQ < $TMP/p2b_fail_second.sql > $TMP/out_p2b_fail.txt 2>&1; echo "[T4 P2b 두 번째 함수 실패 주입] $(grep -m1 -o '가 없어요[^"]*' $TMP/out_p2b_fail.txt | head -1 | cut -c1-60) → 첫 번째 함수까지 원복(정의 해시 동일): $([ "$(snap)" = "$B2" ] && echo YES || echo NO)"
PQ < fix_nicepay_gate_reviewer_flag_20261029.sql > $TMP/out_p2b_ok.txt 2>&1; echo "[T5 P2b 정상] ERROR $(grep -c ERROR $TMP/out_p2b_ok.txt)회"; PQ < verify_fix_nicepay_gate_reviewer_flag_20261029.sql | sed 's/^/   /'
A=$(snap); PQ < add_nicepay_review_center_isolation_20261028.sql >/dev/null 2>&1; PQ < fix_nicepay_gate_reviewer_flag_20261029.sql > $TMP/out_again.txt 2>&1
echo "[T6 재적용(멱등)] P2 재실행 후 P2b 재실행: $(grep -c '건너뜀' $TMP/out_again.txt)개 함수 '건너뜀', 정의 변화 없음: $([ "$(snap)" = "$A" ] && echo YES || echo NO), 잔여물 $(resid) (기대 2/8/12/4)"
echo "[T7 검증 실패 조건 시연] 트리거 1개를 일부러 지우면:"; q "drop trigger trg_orders_nicepay_review_guard on orders" >/dev/null; PQ -x < verify_add_nicepay_review_center_isolation_20261028.sql | grep triggers_must | sed 's/^/   /'; PQ < add_nicepay_review_center_isolation_20261028.sql >/dev/null 2>&1; echo "   (P2 재적용으로 복구) $(PQ -x < verify_add_nicepay_review_center_isolation_20261028.sql | grep triggers_must)"
} 2>&1 | tee "$OUT/atomicity-and-idempotency.txt"
{
echo "=== 2. 데이터 불변·롤백 순서·심사 종료 ==="
PQ < rollback_fix_nicepay_gate_reviewer_flag_20261029.sql >/dev/null 2>&1; PQ < rollback_add_nicepay_review_center_isolation_20261028.sql >/dev/null 2>&1
S0=$(q "$DATA"); PQ < add_nicepay_review_center_isolation_20261028.sql >/dev/null 2>&1; PQ < fix_nicepay_gate_reviewer_flag_20261029.sql >/dev/null 2>&1; S1=$(q "$DATA")
echo "[D1] 센터·상품·수업·주문·수강권·예약·계정·매니저 관계 지문 P2+P2b 적용 전 $S0 / 후 $S1 → 불변: $([ "$S0" = "$S1" ] && echo YES || echo NO)"
PQ < seed_nicepay_review_center_20261028.sql >/dev/null 2>&1; q "update centers set is_internal=false where is_nicepay_review" >/dev/null
echo "[A1] 시드 후(공개 상태) 익명 직접 조회(센터/상품/수업): $(anon) (기대 0/0/0 — 분리 정책 적용 중)"
echo "[R1] 공개 가능한 심사 센터가 있을 때 P2 롤백: $(PQ < rollback_add_nicepay_review_center_isolation_20261028.sql 2>&1 | grep -m1 -o '롤백 중단[^"]*' | cut -c1-60) → 정책 잔존 $(q "select count(*) from pg_policies where policyname='nicepay_review_isolation'") (기대 3)"
X0=$(q "$DATA")
PQ < close_nicepay_review_20261029.sql 2>&1 | grep -E "^(BEGIN|UPDATE|COMMIT)" | tr '\n' ' ' | sed 's/^/[R2 심사 종료 SQL 출력] /'; echo
echo "[R2b] 닫은 뒤 익명 직접 조회: $(anon) (기대 0/0/0), 기존 데이터 지문 변화 없음: $([ "$X0" = "$(q "$DATA")" ] && echo YES || echo NO)"
echo "[R3] P2b 롤백 오류 $(PQ < rollback_fix_nicepay_gate_reviewer_flag_20261029.sql 2>&1 | grep -c ERROR)건 → 게이트 함수 $(PQ < verify_fix_nicepay_gate_reviewer_flag_20261029.sql | tr '\n' ' ')(옛 플래그 복원: 새 플래그 f / 옛 플래그 t)"
echo "[R4] P2 롤백 오류 $(PQ < rollback_add_nicepay_review_center_isolation_20261028.sql 2>&1 | grep -c ERROR)건 → 정책/보호트리거(정확한 이름)/신규 함수 잔여 $(q "select (select count(*) from pg_policies where policyname in ('nicepay_review_isolation','nicepay_own_reservation_class'))||'/'||(select count(*) from pg_trigger where not tgisinternal and tgname ~ '^trg_(centers|accounts|orders|memberships|cart_items|purchase_requests|reservations)_nicepay_review_')||'/'||(select count(*) from pg_proc where proname like 'nicepay_review_center_%' or proname='nicepay_is_reviewer')") (기대 0/1/0 — accounts 보호 트리거만 데이터 보존용으로 남음)"
echo "[R5] 롤백 후 익명 직접 조회: $(anon) (기대 0/0/0 — 센터가 닫혀 있어 분리 정책 없이도 비공개), 기존 데이터 지문 동일: $([ "$X0" = "$(q "$DATA")" ] && echo YES || echo NO)"
q "update centers set is_internal=false where is_nicepay_review" >/dev/null
echo "[R6] (대조) 분리 SQL 없이 공개 가능한 심사 센터를 두면 익명 직접 조회: $(anon) ← 롤백 안전장치가 막으려는 위험 상태"
q "update centers set is_internal=true where is_nicepay_review" >/dev/null
} 2>&1 | tee "$OUT/rollback-and-close.txt"
rm -rf "$TMP"
