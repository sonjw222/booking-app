#!/usr/bin/env bash
# NICEPAY v3 "실제 외부 결제창" 확인 실행기 — 사용자가 직접 실행한다(Claude 가 실행하지 않는다). 승인·청구는 코드가 차단한다(auth-only).
#  · 로컬 격리 Supabase(운영·DEV 아님) + 로컬 개발 서버(:3100) + 실제 NICEPAY 결제창 SDK. 모의 SDK/모의 fetch 없음.
#  · 서버는 MID=nicepay00m + NICEPAY_QA_AUTH_ONLY=true 로만 뜬다 → 인증 결과가 돌아와도 승인·망취소·취소 API 를 호출하지 않고 주문을 정리한다(qaAuthOnly.ts, guardFetch 가 NICEPAY 호스트로의 모든 서버 fetch 를 차단).
#  · MerchantKey 는 코드·파일·로그에 남기지 않는다: 환경변수 NICEPAY_MERCHANT_KEY 로 미리 주거나, 없으면 프롬프트에 입력(화면 에코 없음). 키가 없으면 실행하지 않는다(BLOCKED).
#  · 전제: ISO_ENV_FILE = 로컬 격리 스택 환경 파일(bootstrapEphemeral + nicepayReview/setupLocal.sh + setupExtraPersonas.mjs 이후). 로컬이 아니면 assertIsolated 가 중단시킨다.
# 사용: ISO_ENV_FILE=<env> scripts/isolated/nicepayQa/realWindow.sh      (종료: Ctrl-C)
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${ISO_ENV_FILE:?ISO_ENV_FILE 필요(로컬 격리 스택 환경 파일)}"
node -e "import('./scripts/isolated/nicepayReview/assertIsolated.mjs').then(m=>{m.loadIsolatedEnv(process.env.ISO_ENV_FILE);console.log('isolated guard OK')})"
if [ -z "${NICEPAY_MERCHANT_KEY:-}" ]; then
  if [ -t 0 ]; then read -rsp "테스트 MerchantKey(nicepay00m 용, 화면에 표시되지 않음): " NICEPAY_MERCHANT_KEY; echo; fi
fi
[ -n "${NICEPAY_MERCHANT_KEY:-}" ] || { echo "BLOCKED: 테스트 MerchantKey 가 없어요 — 실제 결제창을 열지 않았고 NICEPAY 호출은 0건입니다."; exit 2; }
set -a; . "$ISO_ENV_FILE"; set +a
export NICEPAY_MERCHANT_KEY
export PAYMENT_RETURN_TOKEN_SECRET="$(head -c 24 /dev/urandom | xxd -p)"
export NICEPAY_MID=nicepay00m NICEPAY_QA_AUTH_ONLY=true NICEPAY_CHECKOUT_ENABLED=true NICEPAY_API_FAMILY=v3_mid NICEPAY_ENV=sandbox NICEPAY_RETURN_BASE_URL=http://localhost:3100 NEXT_PUBLIC_PAYMENT_PROVIDER=nicepay
unset NEXT_PUBLIC_PG_CHECKOUT_ENABLED NODE_OPTIONS
node scripts/qa/nicepayAuthOnlyPreflight.mjs || { echo "사전 점검 실패 — 서버를 시작하지 않아요"; exit 1; }
echo "로컬 서버를 시작합니다 → http://localhost:3100  (심사관 계정으로 로그인 → 심사 센터 → 수강권 → 카드 → 결제하기 → 결제창 확인 → 닫기). 승인·청구는 일어나지 않습니다. 종료: Ctrl-C"
trap 'lsof -ti tcp:3100 2>/dev/null | xargs kill 2>/dev/null || true' EXIT INT TERM
npm run dev -- -p 3100
