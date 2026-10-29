# 만료 상품 주문 처리 E2E QA 보고서 (2026-10-30)

대상: PR #251(만료 고정일 상품 자동 숨김 + 신규 주문 차단), PR #252(만료 상품 기존 pending 직접결제 주문 처리). main 병합 커밋 `cc2acac`.

## 1. 환경 구분 (혼동 금지)
| 구분 | 환경 | 수행 범위 |
|---|---|---|
| **Production** | https://mwhabit.com, Supabase `bxntqggkfwnhcczsbqtj` | 읽기 전용 SELECT + **비로그인** 브라우저 확인만 |
| **Isolated** | 로컬 일회용 Supabase 스택(`isolated-supabase`) + 로컬 `next dev :3021`, 운영과 동일한 `fulfill_order` 해시(`935b66be…`) | 회원 주문 생성 → 센터 관리자 처리 전 시나리오 |

격리 결과는 운영 검증이 **아니다**. 격리 환경의 `[QA] 심사 시험 스튜디오`는 fixture 로 approved 상태이며, 만료는 격리 DB에서 상품 `expiry_date`를 어제로 바꿔 재현했다(운영에서는 수행하지 않음).

## 2. 브라우저/크기
Playwright Chromium. Desktop 1440×900, Mobile = iPhone 13 프로필(390×844, 터치, 라이트 모드). 스크린샷은 `screenshots/` (운영=`P*-production-*`, 격리=`NN-isolated-*`). 개인정보: 격리 fixture 계정(CI User A)만 노출, 운영 스크린샷은 비로그인이라 개인정보 없음.

## 3. Production 결과
| 항목 | 결과 | 근거 |
|---|---|---|
| PR #252 SQL 적용 상태(테이블·RPC·트리거·`fulfill_order` 해시) | PASS | 읽기 전용 SELECT (`prod-readonly-precheck.json`) |
| 만료 상품 공개 목록 숨김(비로그인, A10TION) | PASS | P01·P02. 만료일 지난 상품 전부 숨김, 오늘 만료(10/30)는 표시 |
| QA 센터 화면 접근 | **BLOCKED** | P03 "센터를 찾을 수 없어요" — 원인: **센터 승인 대기(pending)** (상품 설정·계정 권한 아님) |
| 회원 로그인 / QA 주문 생성 | **BLOCKED** | 운영 QA 회원 계정이 로컬에 없음(보유 env 11개 모두 공유 DEV 프로젝트) + QA 센터 승인 대기. 계정·주문을 만들지 않음 |
| 관리자 `/manager/orders` 처리 버튼·처리 시나리오 | **BLOCKED** | 운영 QA 센터 관리자 계정 없음, QA 센터 승인 대기 |
| 만료 상품 신규 주문 차단(운영) | BLOCKED | 위와 동일(주문 시도 불가). 격리에서 검증됨 |
운영 데이터 영향: **없음**. QA 주문/계정 미생성, A10TION 센터 pending 80,000원 주문 2건 시작·종료 시점 동일(재조회 확인), `order_expiry_resolutions` 0행 유지.

## 4. Isolated 결과 (desktop·mobile 각 8개, 총 16 + 회귀)
| 시나리오 | Desktop | Mobile |
|---|---|---|
| M1 회원 로그인→센터 상품 목록→상품 상세/결제 화면→직접결제로 **실제 UI에서 pending 주문 생성** | PASS | PASS |
| M2 만료 후 주문 pending 유지 · 회원 상품 목록에서 상품 사라짐 · 직접 URL 결제 시도/REST INSERT 모두 신규 주문 차단 | PASS | PASS |
| T1 관리자 센터 홈·주문 목록·만료 경고·"만료 상품 주문 처리" 버튼, 일반 "확정·발급" 버튼 없음, 정상 주문은 기존 버튼 | PASS | PASS |
| T2 수납 여부 모름 → pending 유지, 수강권·이력 변화 없음 | PASS | PASS |
| T3 미수납 확인 → 주문 취소 → cancelled, 결제 0, 이력 `unpaid_cancelled` | PASS | PASS |
| T4 수납+환불: 환불 예정(pending+이력, 결제/매출 0) → 환불 완료(cancelled+기록) | PASS | PASS |
| T5 수납+이용기간 조정 → 결제 1건·새 만료일 수강권, 상품 만료일 불변 | PASS | PASS |
| T6 직접 일반 발급(`fulfill_order`) 가드 차단 · 주문 status/amount 직접 UPDATE 거부 · 정상 상품 주문은 기존 흐름 done | PASS | PASS |
회귀: 기존 `tests/expired-order-qa`(12 + 신규 16 = 28 passed), `scripts/isolated/expiredOrder/verify.mjs` 95/95 PASS (`isolated-run/verify-regression.json`).
버그: **발견 없음**(실패는 모두 내 시험 코드 오류 — 만료 주문 개수 기대값 오기, 이력 테이블에 `created_at` 없음 — 수정 후 통과).
실제 결제·환불·고객 알림: 없음(직접결제만, 외부 호출 없음).

## 5. 핵심 스크린샷
회원: `01`~`09`(로그인 후, 상품 목록 **만료 전**(`02-…-before-expiry`), 결제 상세, 직접결제, pending 생성, 상품 목록 **만료 후**(`06-…-after-expiry`), 직접 URL 차단("상품 정보를 찾을 수 없어요"), 구매내역). `02`/`06` 은 같은 기준 행(정상 상품)을 화면 가운데로 스크롤해 찍어 **만료 상품 행이 정상 상품 바로 아래에 있다가(전) 사라진(후)** 차이가 보인다(desktop·mobile 모두). 관리자: `10`~`25`(센터 홈, 주문 목록, 만료 경고, 처리 버튼, 방식 시트, 미수납 취소 확인, 환불 예정, 환불 완료, 기간 조정, 결과, 정상 주문).

## 6. 남은 QA 항목
- 운영 회원/관리자 로그인 기반 실브라우저 QA: 운영 QA 계정 확보 + QA 센터 승인(사용자 결정) 후 가능.
- 실제 PG 결제·환불 경로: 결제 OFF 정책으로 범위 밖.
- 운영 `/manager/orders`의 A10TION 만료 주문 2건 실제 처리: 사용자 지시 전 금지.

## 7. 개인정보 보호 조치
- `screenshots/P02-production-anon-a10tion-center-desktop.png`: 운영 센터 화면 좌측에 센터 연락처(휴대폰 번호)가 일부 보여 개인정보 보호를 위해 해당 영역을 불투명 검은 사각형으로 마스킹했습니다. 마스킹 외 화면은 원본과 동일하며, 마스킹 전 이미지는 Git 이력에 포함하지 않았습니다.

## 8. 자동 CI 실행 (격리 전용)
**workflow**: `.github/workflows/expired-order-qa.yml` — `tests/expired-order-qa/member-to-manager.spec.ts`(desktop 8 + mobile 8 = 16 tests)를 GitHub Actions 러너 안의 일회용 Supabase 스택에서 자동 실행한다.
- **언제 도나**: 이 spec·설정·관련 SQL·`app/manager/orders`·`app/center`·`app/checkout`·`lib/orders.ts|center.ts|servicePeriod.ts` 를 바꾸는 같은 저장소 PR, 또는 수동 실행(workflow_dispatch). push·fork PR 에서는 돌지 않는다.
- **무엇을 하나(순서)**: ① 일회용 스택 기동 + 가드(`isolatedTargetGuard` OK 가 아니면 중단) + 테스트 계정·센터 fixture(`isolated-supabase` action) → ② `scripts/isolated/expiredOrder/applyProdParity.sh`: 러너의 **로컬 컨테이너에만** 운영 적용본과 같은 정의 상태를 만든 뒤(NICEPAY 선행 SQL → P2/P2b → #251 `fix_expired_fixed_date_products` → 운영 `fulfill_order` 정의 → #252 `add_expired_order_resolution`, `fulfill_order` 해시 `935b66be…` 일치 확인) → ③ `npx playwright test --config playwright.expiredorderqa.config.ts`(앱 서버 `next dev -p 3021` 를 설정이 직접 띄움; 기본 `playwright.config.ts` 의 :3000 과 겹치지 않고 CI 에서는 점유 서버를 재사용하지 않음) → ④ 스크린샷·결과 JSON 만 artifact(3일, trace/video 제외) → ⑤ 스택 항상 종료.
- **안전장치**: Secrets·`vars`·운영/DEV 식별자 없음. 설정(`playwright.expiredorderqa.config.ts`)이 Supabase URL 이 로컬이 아니거나 실제 PG·알림 자격증명 환경변수(NICEPAY/TOSS/PORTONE/ALIGO 등)가 있으면 즉시 중단. 직접결제만 사용(PG 게이트·알림 설정 없음). 정적 계약: `tests/unit/expiredOrderQaWorkflow.contract.test.ts`.
- **로컬에서 같은 단계로 실행**: `supabase start --workdir isolated-supabase --exclude studio,imgproxy,vector,logflare,supavisor,postgres-meta` → `eval "$(node scripts/isolated/stackEnv.mjs)"` → `node scripts/isolated/bootstrapEphemeral.mjs --out .tmp/isolated.env` → `bash scripts/isolated/expiredOrder/applyProdParity.sh` → `set -a; . .tmp/isolated.env; set +a; CI=1 EXPIREDORDER_START_SERVER=1 EXPIREDORDER_OUT=.tmp/out npx playwright test --config playwright.expiredorderqa.config.ts` → `supabase stop --no-backup --workdir isolated-supabase`.
- **실행 결과**: 위 단계를 로컬 일회용 스택(db reset 직후)에서 그대로 재현해 **16/16 passed**(`isolated-run/ci-equivalent-run-summary.json`). GitHub Actions 실제 실행 결과는 push 후 첫 PR 실행에서 확인한다(이 보고서 작성 시점에는 push 전).
- **spec 변경(자동화 필수)**: 새 스택에는 센터에 매니저 행이 없어 처음엔 T1(관리자)에서 실패했다 → 매니저 A 를 오너로 "없으면 생성/있으면 갱신"하도록 fixture 를 보강. 테스트 기대값·단언은 바꾸지 않았다. `02`/`06` 스크린샷 촬영 위치만 스크롤로 조정.

## 9. 운영 검증과 격리 검증의 차이 (혼동 금지)
| | Production (운영) | Isolated (로컬/CI 일회용 스택) |
|---|---|---|
| 데이터 | 실제 센터·상품·주문 | 테스트 전용 fixture(CI User A 등), 실행마다 새 비밀번호, 끝나면 스택 삭제 |
| 수행 | 읽기 전용 SELECT + 비로그인 브라우저 | 회원 주문 생성 → 관리자 처리 전 시나리오(쓰기 포함) |
| 만료 재현 | 하지 않음(운영 상품·주문 변경 금지) | 격리 DB 에서 상품 `expiry_date` 를 어제로 바꿔 재현 |
| 로그인 시나리오 | **BLOCKED**(운영 QA 계정 없음, QA 센터 승인 대기) | PASS 16/16 |
| 보증 범위 | 운영 SQL 적용 상태, 공개 목록 숨김 | 코드·SQL **동작**(운영과 같은 함수 해시 상태 위에서). 운영 인프라·실데이터·실제 결제/알림은 검증하지 않음 |
격리 PASS 는 운영 QA 통과가 **아니다**. 운영 로그인 QA 는 운영 QA 계정 + QA 센터 승인(사용자 결정) 뒤에 별도로 수행한다.

## 10. 증빙 파일 정리
- `isolated-run/screenshots/`(50장)는 본문 `screenshots/` 의 같은 이름 파일과 바이트 단위로 동일하고 어디에서도 참조되지 않아 삭제했다. 증빙 원본은 `screenshots/`(운영 `P*`, 격리 `NN-isolated-*`) 한 곳에만 둔다.
- `02`/`06` 4장(desktop·mobile)은 위 CI 재현 실행에서 다시 촬영해 교체했다(나머지 `01·03~05·07~25` 는 1차 실행 증빙 그대로 — 두 실행 모두 16/16 통과). 개인정보: 격리 fixture 계정만 노출, P02 마스킹(§7) 유지.
