#!/usr/bin/env bash
# NICEPAY v3 결제창 격리 브라우저 QA 실행기 — 로컬 일회용 Supabase 전용. 실제 NICEPAY 호출 0건(모의 SDK + fetch 가로채기).
# 전제: supabase start(isolated-supabase) + bootstrapEphemeral + nicepayReview/setupLocal.sh + setupExtraPersonas.mjs. 사용: ISO_ENV_FILE=<env> NPQA_OUT=<디렉터리> scripts/isolated/nicepayQa/run.sh [playwright 인자]
# ⚠ 코드 상수 NICEPAY_CHECKOUT_ACTIVATED 를 "이 실행 동안만" 작업 트리에서 true 로 바꾸고, 종료(정상/오류/중단) 시 반드시 원복한다. 원복 후 git diff 가 비어 있지 않으면 실패로 끝낸다. 커밋 금지.
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${ISO_ENV_FILE:?ISO_ENV_FILE 필요}"
node -e "import('./scripts/isolated/nicepayReview/assertIsolated.mjs').then(m=>{m.loadIsolatedEnv(process.env.ISO_ENV_FILE);console.log('isolated guard OK')})"
FACT=lib/payments/PaymentProviderFactory.ts
[ -z "$(git status --porcelain -- $FACT)" ] || { echo "$FACT 에 이미 변경이 있어요 — 중단"; exit 1; }
DEV_PID=""
restore() { [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null || true; lsof -ti tcp:3100 2>/dev/null | xargs kill 2>/dev/null || true;   # 포트 3100 의 이 실행 서버만 종료(다른 세션의 :3000 서버는 건드리지 않는다)
  git checkout -- $FACT; rm -rf .next/cache 2>/dev/null || true; }
trap restore EXIT INT TERM
set -a; . "$ISO_ENV_FILE"; set +a
export NPQA_OUT="${NPQA_OUT:-docs/qa/nicepay-main-integration-20261031/qa}"; mkdir -p "$NPQA_OUT"
export NICEPAY_QA_CONTROL="$NPQA_OUT/control.json" NICEPAY_QA_LOG="$NPQA_OUT/nicepay-calls.jsonl"; echo '{}' > "$NICEPAY_QA_CONTROL"; : > "$NICEPAY_QA_LOG"
# 로컬 전용 가짜 자격(무작위, 커밋·출력 금지)
export NICEPAY_MID="QA$(head -c 6 /dev/urandom | xxd -p | cut -c1-8)m" NICEPAY_MERCHANT_KEY="$(head -c 24 /dev/urandom | xxd -p)" PAYMENT_RETURN_TOKEN_SECRET="$(head -c 24 /dev/urandom | xxd -p)"
export NEXT_PUBLIC_PAYMENT_PROVIDER=nicepay NICEPAY_CHECKOUT_ENABLED=true NICEPAY_API_FAMILY=v3_mid NICEPAY_ENV=sandbox NICEPAY_RETURN_BASE_URL=http://localhost:3100
export NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER="${NPQA_ADDRESS_FLAG:-true}"   # 기본 true: 심사 요구(홈 하단 주소)를 "플래그를 켰을 때" 충족하는지 검증(스크린샷 없음). NPQA_ADDRESS_FLAG=false 는 실제 배포 기본값(꺼짐) — 주소가 화면에 찍히면 안 되는 스크린샷 QA 는 이쪽으로 실행
unset NEXT_PUBLIC_PG_CHECKOUT_ENABLED   # 일반 회원 결제를 열지 않는다
if [ -z "${NPQA_CONSTANT_OFF:-}" ]; then
  sed -i.bak 's/export const NICEPAY_CHECKOUT_ACTIVATED: boolean = false;/export const NICEPAY_CHECKOUT_ACTIVATED: boolean = true;/' $FACT && rm -f $FACT.bak
  grep -q "NICEPAY_CHECKOUT_ACTIVATED: boolean = true" $FACT || { echo "활성 상수 전환 실패"; exit 1; }
else
  echo "NPQA_CONSTANT_OFF=1 — 코드 상수를 바꾸지 않는다(결제 비활성 검증: 환경변수·게이트가 모두 켜져도 코드 상수가 false 면 결제창이 열리지 않아야 한다)"
  grep -q "NICEPAY_CHECKOUT_ACTIVATED: boolean = false" $FACT || { echo "상수가 false 가 아니에요"; exit 1; }
fi
NODE_OPTIONS="--require $PWD/tests/nicepay-qa/mockNicepayFetch.cjs" npm run dev -- -p 3100 > "$NPQA_OUT/dev-server.log" 2>&1 & DEV_PID=$!
for i in $(seq 1 60); do curl -sf -o /dev/null http://localhost:3100/login && break; sleep 2; done
curl -sf -o /dev/null http://localhost:3100/login || { echo "앱 서버 기동 실패"; exit 1; }
set +e; npx playwright test -c playwright.nicepayqa.config.ts "$@"; RC=$?; set -e
restore; trap - EXIT INT TERM
# 서버 로그의 복귀 토큰(rt)·토큰류는 증거에 남기지 않는다(로컬 무작위 시크릿으로 서명된 값이지만 습관적으로 가린다)
sed -E -i.bak "s/(rt=)[A-Za-z0-9_.%-]+/\\1<redacted>/g; s/eyJ[A-Za-z0-9_-]{20,}/<jwt-redacted>/g" "$NPQA_OUT/dev-server.log" && rm -f "$NPQA_OUT/dev-server.log.bak"
[ -z "$(git status --porcelain -- $FACT)" ] || { echo "⚠ $FACT 원복 실패"; exit 1; }
echo "코드 상수 원복 확인(git diff 없음). 종료 코드 $RC"; exit $RC
