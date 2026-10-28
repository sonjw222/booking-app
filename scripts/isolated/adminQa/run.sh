#!/usr/bin/env bash
# 관리자 QA(#239) 실행기 — 로컬 격리 스택 전용. 전제: supabase start(isolated-supabase) + bootstrapEphemeral + seedAdminPagination(플랫폼 관리자) + seedAdminQa.
# 사용: ISO_ENV_FILE=<env 파일> ADMINQA_OUT=<결과 디렉터리> scripts/isolated/adminQa/run.sh [playwright 인자…]
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${ISO_ENV_FILE:?ISO_ENV_FILE 필요}"
node -e "import('./scripts/isolated/adminQa/assertIsolated.mjs').then(m=>{m.loadIsolatedEnv(process.env.ISO_ENV_FILE);console.log('isolated guard OK')})"
set -a; . "$ISO_ENV_FILE"; set +a
export ADMINQA_OUT="${ADMINQA_OUT:-docs/qa/admin-qa-238-239-20261030/adminqa}"
mkdir -p "$ADMINQA_OUT"; rm -rf test-results-adminqa/.auth
curl -sf -o /dev/null http://localhost:3000/login || { echo "앱 서버(localhost:3000, 격리 env)가 떠 있어야 해요: npm run dev"; exit 1; }
npx playwright test -c playwright.adminqa.config.ts "$@"
