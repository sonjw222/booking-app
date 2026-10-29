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
회원: `01`~`09`(로그인 후, 상품 목록, 결제 상세, 직접결제, pending 생성, 만료 후 상품 사라짐, 직접 URL 차단("상품 정보를 찾을 수 없어요"), 구매내역). 관리자: `10`~`25`(센터 홈, 주문 목록, 만료 경고, 처리 버튼, 방식 시트, 미수납 취소 확인, 환불 예정, 환불 완료, 기간 조정, 결과, 정상 주문).

## 6. 남은 QA 항목
- 운영 회원/관리자 로그인 기반 실브라우저 QA: 운영 QA 계정 확보 + QA 센터 승인(사용자 결정) 후 가능.
- 실제 PG 결제·환불 경로: 결제 OFF 정책으로 범위 밖.
- 운영 `/manager/orders`의 A10TION 만료 주문 2건 실제 처리: 사용자 지시 전 금지.

## 7. 개인정보 보호 조치
- `screenshots/P02-production-anon-a10tion-center-desktop.png`: 운영 센터 화면 좌측에 센터 연락처(휴대폰 번호)가 일부 보여 개인정보 보호를 위해 해당 영역을 불투명 검은 사각형으로 마스킹했습니다. 마스킹 외 화면은 원본과 동일하며, 마스킹 전 이미지는 Git 이력에 포함하지 않았습니다.
