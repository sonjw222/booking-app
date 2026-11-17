#!/usr/bin/env bash
# 실제 결제창 QA 용 로컬 격리 스택 준비 — 로컬 Docker 의 일회용 Supabase(운영·DEV 아님)만 사용. 운영 SQL·운영 환경변수 접근 없음.
#  1) supabase start(isolated-supabase) → db reset(로컬) → 환경 파일 생성(기본 ~/.nicepay-qa/iso.env, 권한 600, Git 밖) → 심사관·센터·상품 fixture 구성.
#  끝나면 출력되는 ISO_ENV_FILE 로 realWindow.sh 를 실행한다. 정리: supabase stop --no-backup --workdir isolated-supabase
set -euo pipefail
cd "$(dirname "$0")/../../.."
OUT="${NPQA_ENV_DIR:-$HOME/.nicepay-qa}"; mkdir -p "$OUT"; chmod 700 "$OUT"
supabase start --workdir isolated-supabase --exclude studio,imgproxy,vector,logflare,supavisor,postgres-meta >/dev/null 2>&1
supabase db reset --workdir isolated-supabase --local >/dev/null 2>&1
node scripts/isolated/stackEnv.mjs > "$OUT/stack.env"; chmod 600 "$OUT/stack.env"
set -a; . "$OUT/stack.env"; set +a
node scripts/ci/isolatedTargetGuard.mjs | cut -c1-80
node scripts/isolated/bootstrapEphemeral.mjs --out "$OUT/iso.env" | tail -1 | cut -c1-50; chmod 600 "$OUT/iso.env"
export ISO_ENV_FILE="$OUT/iso.env"
bash scripts/isolated/nicepayReview/setupLocal.sh 2>&1 | tail -2
node scripts/isolated/nicepayReview/setupExtraPersonas.mjs 2>&1 | tail -2
echo "READY: ISO_ENV_FILE=$OUT/iso.env  (값은 출력하지 않음)"
