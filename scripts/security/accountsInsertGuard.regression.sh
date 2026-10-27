#!/usr/bin/env bash
# 일회용 로컬 Supabase(컨테이너 supabase_db_mwhabit-isolated 고정) 전용 회귀: 수정 전엔 검증이 실패(취약점 재현), 적용 후엔 통과, 보호를 제거/약화하면 다시 실패해야 한다.
# 하나라도 기대와 다르면 종료 코드 1. 사용: ISO_ENV_FILE=<환경 파일> scripts/security/accountsInsertGuard.regression.sh <출력 디렉터리>
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=${1:?출력 디렉터리 필요}; mkdir -p "$OUT"; : "${ISO_ENV_FILE:?ISO_ENV_FILE 필요}"
FIX=fix_accounts_insert_privileged_columns_20261030.sql; FAILS=0
PQ() { docker exec -i supabase_db_mwhabit-isolated psql -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
trig() { echo "select count(*) from pg_trigger where tgrelid='public.accounts'::regclass and tgname='trg_accounts_insert_privileged_columns'" | PQ; }
check() { local name=$1 expect=$2 actual=$3; if [ "$expect" = "$actual" ]; then echo "PASS $name (기대 $expect)"; else echo "FAIL $name — 기대 $expect / 실제 $actual"; FAILS=$((FAILS+1)); fi; }
verify() { ISO_ENV_FILE="$ISO_ENV_FILE" node scripts/security/accountsInsertGuard.verify.mjs "$OUT/$1.json" > "$OUT/$1.log" 2>&1; echo $?; }
echo "== 0. 적용 전(취약 상태) =="; echo "drop trigger if exists trg_accounts_insert_privileged_columns on accounts; drop function if exists enforce_accounts_insert_privileged_columns();" | PQ >/dev/null
check "트리거 없음" 0 "$(trig)"; check "적용 전 검증은 실패(취약점 재현, 종료 코드 1)" 1 "$(verify phase0-before-fix)"; echo "   실패 항목 수: $(grep -c '^FAIL' $OUT/phase0-before-fix.log)"
echo "== 1. 수정 적용 =="; PQ < $FIX >/dev/null 2>"$OUT/apply1.err"; check "적용 종료 코드" 0 "$?"; check "트리거 존재" 1 "$(trig)"; check "적용 후 검증 통과(종료 코드 0)" 0 "$(verify phase1-after-fix)"
echo "== 2. 재적용(멱등) =="; PQ < $FIX >/dev/null 2>&1; check "재적용 종료 코드" 0 "$?"; check "트리거 1개" 1 "$(trig)"; check "재적용 후 검증 통과" 0 "$(verify phase2-reapply)"
echo "== 3. 보호 제거 회귀(변조) =="
echo "drop trigger trg_accounts_insert_privileged_columns on accounts" | PQ >/dev/null; check "트리거 제거 후 검증은 실패해야 함" 1 "$(verify phase3a-trigger-removed)"
echo "create trigger trg_accounts_insert_privileged_columns before update on accounts for each row execute function enforce_accounts_insert_privileged_columns()" | PQ >/dev/null; check "UPDATE 로만 걸린 약화 트리거에서도 검증은 실패해야 함" 1 "$(verify phase3b-update-only)"
echo "create or replace function enforce_accounts_insert_privileged_columns() returns trigger language plpgsql security definer set search_path=public as \$\$ begin return new; end \$\$; drop trigger trg_accounts_insert_privileged_columns on accounts; create trigger trg_accounts_insert_privileged_columns before insert on accounts for each row execute function enforce_accounts_insert_privileged_columns();" | PQ >/dev/null; check "함수 본문을 비운 트리거에서도 검증은 실패해야 함" 1 "$(verify phase3c-empty-function)"
echo "== 4. 복구 =="; PQ < $FIX >/dev/null 2>&1; check "복구 적용" 0 "$?"; check "복구 후 검증 통과" 0 "$(verify phase4-restored)"
echo "== 5. 원자성(적용 도중 실패 → 아무것도 남지 않음) =="
echo "drop trigger if exists trg_accounts_insert_privileged_columns on accounts; drop function if exists enforce_accounts_insert_privileged_columns();" | PQ >/dev/null
python3 - "$FIX" "$OUT/fail.sql" <<'PY'
import sys
s=open(sys.argv[1]).read().rstrip(); assert s.endswith("commit;"); open(sys.argv[2],'w').write(s[:-len("commit;")]+"select 1/0;\ncommit;\n")
PY
docker exec -i supabase_db_mwhabit-isolated psql -U postgres -At < "$OUT/fail.sql" > "$OUT/fail.out" 2>&1; check "실패 주입 SQL 은 오류를 낸다" 1 "$(grep -c 'division by zero' $OUT/fail.out)"; check "실패 후 트리거 없음(전체 롤백)" 0 "$(trig)"; check "실패 후 함수 없음" 0 "$(echo "select count(*) from pg_proc where proname='enforce_accounts_insert_privileged_columns'" | PQ)"
PQ < $FIX >/dev/null 2>&1; check "최종 복구(수정 적용 상태로 종료)" 1 "$(trig)"
echo; if [ "$FAILS" -eq 0 ]; then echo "ALL EXPECTATIONS MET"; else echo "$FAILS EXPECTATION(S) FAILED"; fi; exit $([ "$FAILS" -eq 0 ] && echo 0 || echo 1)
