# NICEPAY v3 테스트 결제창 격리 QA (auth-only) — 2026-10-30

목적: 심사관 로그인 → 심사 센터 → 수강권(3종) → 카드 → 결제하기 → **NICEPAY v3 결제창 표시·닫기**까지 확인하고, **승인 API 는 한 번도 호출하지 않는다.** 운영 DB·운영 Vercel 환경변수·운영 MID/키는 건드리지 않는다. SQL 변경 없음.

## 1. 안전장치 (fail-closed, 코드: `lib/payments/server/nicepay/qaAuthOnly.ts`)
| # | 장치 | 위치 |
|---|---|---|
| 1 | 공용 테스트 MID `nicepay00m` 이면 **플래그 없이도** auth-only 강제. `NICEPAY_QA_AUTH_ONLY=true` 도 같은 모드 | `config.ts` |
| 2 | auth-only 인데 MID≠`nicepay00m`, 운영 MID(`mwhabit01m/02m`), `NICEPAY_ENV≠sandbox`, family≠`v3_mid`, `VERCEL_ENV=production`, 일반회원 결제 ON(`NEXT_PUBLIC_PG_CHECKOUT_ENABLED=true`), Supabase 미설정·**운영 프로젝트**, 복귀 호스트가 운영 도메인이면 → NICEPAY 설정 전체 거부(`qa_unsafe`, 항목 이름만 로그) | `config.ts`, `qaAuthOnly.ts` |
| 3 | 인증 결과가 돌아오면 서명·MID·금액·주문·게이트·URL 검증 후 **주문 선점(claim)·승인 호출 이전에** 종료 → 주문을 `cancelled` 로 정리, 결과 화면은 "QA 테스트: 승인하지 않았어요" | `lifecycle.ts`, `flow.ts`, `app/checkout/nicepay/result/page.tsx` |
| 4 | 서버의 모든 fetch 를 `guardFetch` 로 감싸 *.nicepay.co.kr 호출(승인·망취소·취소·환불)을 예외로 차단 | `runtime.ts` |
| 5 | 일반 회원: 카드 결제수단 미노출(기존 게이트 `reviewer` + `NEXT_PUBLIC_PG_CHECKOUT_ENABLED` 미설정) | 기존 |
| 6 | 결제창을 닫으면 대기 주문 정리(기존 `cancelPendingOrder`) | 기존 |
| 7 | MerchantKey 는 서버 env 에서만 읽음. 하드코딩·출력·커밋 금지, 브라우저에 노출 0(테스트로 확인) | 테스트 |

## 2. 검증 결과 (로컬 격리, 모의 결제창 — **실제 외부 결제창 아님**)
- 단위: `tests/unit/nicepay.qaAuthOnly.test.ts`(16), `nicepay.qaPreflight.test.ts`(3) 통과.
- 격리 브라우저: `NPQA_AUTH_ONLY=1 scripts/isolated/nicepayQa/run.sh tests/nicepay-qa/authOnly.spec.ts` 11/11 통과 — 심사관 로그인·센터·3 수강권·카드 표시·일반회원 차단·금액=DB 가격·v3 파라미터·키 노출 0·잘못된 주문/금액 차단·열고 닫기·인증 완료(모의)에도 승인/망취소/외부 호출 **0건**.
- 기본 모드 회귀(`run.sh`, 기존 승인 경로 QA) 23 통과(auth-only 시험 15건은 해당 모드 전용이라 skip).
- **실제 NICEPAY 외부 결제창: BLOCKED** — 테스트 MerchantKey 가 이 환경에 없음. NICEPAY 호출 0건.

## 3. 실제 결제창 확인 방법 (사용자가 직접)
권장: **로컬 개발 서버 + 로컬 격리 Supabase + 실제 SDK** (`scripts/isolated/nicepayQa/realWindow.sh`).
1. 로컬 격리 스택 준비(`supabase start --workdir isolated-supabase` → `scripts/isolated/bootstrapEphemeral.mjs` → `nicepayReview/setupLocal.sh` → `setupExtraPersonas.mjs`) 후 `ISO_ENV_FILE=<env>` 지정.
2. `ISO_ENV_FILE=<env> scripts/isolated/nicepayQa/realWindow.sh` — MerchantKey 를 프롬프트에 입력(화면 에코 없음, 파일·로그에 남지 않음). 키가 없으면 실행하지 않음(BLOCKED, 종료 코드 2).
3. http://localhost:3100 에서 심사관 계정으로 로그인 → 심사 센터 → 수강권 → 카드 → 결제하기 → 결제창 확인 → 닫기(또는 테스트 카드 인증). **승인·청구는 일어나지 않고** 주문은 정리됩니다.
4. 확인할 것: 결제창이 열림, 금액·상품명 일치, 닫으면 주문 `cancelled`, 인증 완료 시 "QA 테스트: 승인하지 않았어요" 화면.
`nicepay00m` 키로 NICEPAY 가 `http://localhost` ReturnURL 을 허용하지 않으면 결제창이 오류를 낼 수 있음 → 그 경우 아래 Preview 방식.

## 4. Vercel Preview 방식 (브랜치 한정, 사용자 설정)
Vercel → 프로젝트 → Settings → Environment Variables → 각 항목 추가 시 **Environment 는 Preview 만, "Select a custom Preview branch"(Branch)에 `qa/nicepay-auth-only-20261030`** 지정(Production 체크 금지).
| 이름 | 값 |
|---|---|
| `NICEPAY_QA_AUTH_ONLY` | `true` |
| `NICEPAY_CHECKOUT_ENABLED` | `true` |
| `NICEPAY_API_FAMILY` | `v3_mid` |
| `NICEPAY_ENV` | `sandbox` |
| `NICEPAY_MID` | `nicepay00m` |
| `NICEPAY_MERCHANT_KEY` | (테스트 MerchantKey — **Sensitive** 로 저장, 채팅·Git 에 붙이지 않기) |
| `NICEPAY_RETURN_BASE_URL` | 이 브랜치 Preview 의 주소(Preview URL, 비공개 보관) |
| `PAYMENT_RETURN_TOKEN_SECRET` | 새 무작위 문자열(운영 값 재사용 금지) |
| `NEXT_PUBLIC_PAYMENT_PROVIDER` | `nicepay` |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | **운영이 아닌 테스트 DB** 값(운영 ref 면 서버가 거부) |
`NEXT_PUBLIC_PG_CHECKOUT_ENABLED` 는 설정하지 않습니다. 설정 후 `vercel env pull --environment=preview --git-branch=qa/nicepay-auth-only-20261030 .env.qa` → `node scripts/qa/nicepayAuthOnlyPreflight.mjs --env-file .env.qa` 가 FAIL 0 인지 확인(값은 출력되지 않음, `.env.qa` 는 커밋 금지·확인 후 삭제).
주의: Preview 는 Vercel 인증(SSO) 보호라 외부 결제창의 ReturnURL 교차 사이트 POST 가 막힐 수 있음(auth-only 라 승인 불필요, 결제창 표시·닫기 확인에는 영향 없음). 테스트 DB 에는 심사 센터·상품·게이트(`reviewer`)·심사관 계정이 있어야 함(로컬 `setupLocal.sh` 와 같은 구성, 운영 SQL 아님).
키 범위 확인 필요: `nicepay00m` 용 키가 별도 발급인지(공개 샘플 키 사용 여부)는 NICEPAY 문서/담당자 확인.

## 5. 해제
테스트 후 Preview 환경변수(위 표) 삭제. 브랜치는 main 에 병합하지 않음(Draft PR).
