# NICEPAY 서버 모듈 재검증 (Batch 2) — 2026-10-16

대상: `lib/payments/server/nicepay/{signature,types,redact,api,lifecycle,billing}.ts`. 실제 NICEPAY 호출 없음 — 공식 문서(`developers.nicepay.co.kr/docs/pg/auth/*`, `add/noti`) 대비 + 오프라인 테스트 43개(`tests/unit/nicepay.offline.test.ts`)로 확인.

## 1. 규격 대조 (공식 문서 기준)
| 항목 | 문서 | 구현 | 상태 |
|---|---|---|---|
| 결제창 SignData | sha256(EdiDate+MID+Amt+Key) | `nicepaySign.payRequest` | 일치(테스트) / 결제창 호출 자체는 BLOCKED(MID/KEY) |
| 인증결과 Signature | sha256(AuthToken+MID+Amt+Key) | `authResult` + 상수시간 비교 | 일치 |
| 승인 요청 SignData | sha256(AuthToken+MID+Amt+EdiDate+Key) | `approveRequest` | 일치 |
| 승인 응답 Signature | sha256(TID+MID+Amt+Key) | `approveResponse` | 일치 |
| 망취소 | NetCancelURL, NetCancel=1, SignData = 승인 요청과 동일 공식, 성공 2001 | `nicepayNetCancel` | 일치 |
| 취소 | `cancel_process.jsp`, PartialCancelCode 0/1, SignData=sha256(MID+CancelAmt+EdiDate+Key), 성공 2001/2211, 응답 Signature=sha256(TID+MID+CancelAmt+Key) | `nicepayCancel`(전액만) | 요청 일치. **취소 응답 Signature 검증은 아직 코드에 없음** → 활성화 전 보강 항목(응답 서명 함수는 `cancelResponse`로 준비됨) |
| 성공 코드 | 카드 3001 | 3001만 허용 | 일치(계좌이체 4000·가상계좌 4100·휴대폰 A000은 범위 밖) |
| 금액 표기 | 12자리 0패딩 예시 | 정수 문자열로 서명, 응답은 0패딩 허용 파싱 | **BLOCKED**: 서명 시 패딩 포함 여부 기술지원 확인 |
| 인코딩 | 기본 EUC-KR | `CharSet=utf-8, EdiType=JSON` 명시 | 문서상 선택 가능 값. 실제 응답 확인은 BLOCKED |
| 타임아웃 | 연결 5초·응답 30초 | 30초 abort | 연결 5초 분리는 미구현(런타임 의존) |
| 웹훅 | 서명 없음, 재시도 최대 10회, IP 3개 | 분류만 | 규격상 위조 방어 수단 없음 → BLOCKED(기술지원) |
| 거래 조회 API | (문서에서 확인 못 함) | 없음 | **BLOCKED** |

## 2. 위험 시나리오별 검증 (모두 오프라인 테스트로 고정)
| 시나리오 | 동작 |
|---|---|
| 서명 변조 / 금액 변조 / 다른 MID / 필수값 누락 | 승인 호출 전 400, 선점·DB 접근 없음 |
| NextAppURL/NetCancelURL 변조(비공식 호스트·http·userinfo·포트) | 승인 전 거부 → AuthToken·서명이 외부로 나가지 않음 |
| PG 게이트 OFF(`gateAllows` false) | 403, 선점·NICEPAY 호출 없음 |
| 주문 없음 / 다른 provider / cancelled·approving / DB 금액 불일치 | 승인 호출 없음 |
| 이미 done | 승인 호출 없이 멱등 성공(수강권 중복 발급 없음) |
| 동시 중복(선점 실패) / 재시도 시 이미 approving | 승인·망취소 모두 없음 → 중복 승인·중복 발급 방지 |
| 승인 확정 거절(코드≠3001, HTTP 4xx) | 돈 이동 없음 → 망취소하지 않고 주문 pending 복귀 |
| **결과 불명**(네트워크 오류·타임아웃·5xx·2xx 본문 해석 불가) | **성공/실패로 확정하지 않고** 망취소 1회 시도. 성공하면 거래 정리 후 pending 복귀+재시도 안내, 실패하면 아래 §3 |
| 승인 응답 위변조(서명/금액/Moid/TID/MID 불일치) | DB 확정 없이 망취소 |
| DB 확정 실패 | 재조회: done이면 취소하지 않음(응답 유실) / pending이면 망취소 / 재조회마저 실패하면 자동 취소하지 않고 `markReview` |
| 망취소 실패 | `markReview("netcancel_failed")`, 주문은 approving 유지(재승인 불가), 사용자에게는 운영자 문의 안내 |
| 웹훅 중복·위조 | 상태를 바꾸지 않고 DB 대조 분류만(ignore / confirm_needed / mismatch / unknown_order / bad_payload) |
| 로그 | 허용 목록만 기록(카드·구매자·토큰·서명·키 제외), 테스트로 고정 |

**망취소 허용 조건**(코드 고정): ① 검증된 인증 결과(서명·MID·금액·주문 모두 통과)와 허용 호스트의 NetCancelURL이 있고 ② 이 요청이 주문 선점에 성공했으며 ③ 승인 요청을 보낸 뒤이고 ④ 결과가 불명이거나 승인 후 검증/DB 확정이 실패했고 ⑤ DB가 done이 아님을 확인했을 때만. 확정 거절이거나 DB가 이미 done이면 보내지 않는다. 한 요청에서 최대 1회.

## 3. 운영자 확인·수동 복구 절차 (설계, 활성화 시 적용)
`markReview`가 남기는 신호: 주문 `approving` 유지 + 영속 표시(구현은 SQL 승인 후: `orders.pg_review_reason`, `pg_review_at` 또는 `payment_review_queue` 테이블) + 로그 `PG_NICEPAY_NETCANCEL_FAILED` / `PG_NICEPAY_CONFIRM_STATE_UNKNOWN`(Vercel 로그에서 검색).
1. 로그의 마스킹 Moid(뒤 6자리)로 주문 식별 → 주문 상태가 `approving`인지 확인.
2. **NICEPAY 가맹점관리자**에서 해당 주문(Moid)·TID의 실제 상태 확인(승인됨/미승인/망취소됨). (조회 API가 확인되면 자동화 — 현재 BLOCKED)
3. 케이스별:
   - NICEPAY 미승인/망취소됨 → 주문을 `pending`(재시도 허용) 또는 `cancelled`로 정리, 포인트는 기존 취소 RPC가 복원.
   - NICEPAY 승인됨 + 우리 DB 미확정 → 금액·Moid 일치 확인 후 `confirm_real_payment`(멱등)를 서버 도구로 실행해 수강권 발급, 또는 사용자 요청 시 가맹점관리자에서 취소.
   - 승인됨 + 금액 불일치 → 가맹점관리자에서 즉시 취소.
4. 처리 후 `markReview` 표시 해제 + 기록(누가·언제·무엇을). 웹훅의 `confirm_needed`/`mismatch` 분류도 같은 큐로 보낸다.
이 절차 어느 단계도 DB 쓰기는 활성화 시점의 승인된 도구/SQL로만 수행한다. 이번 작업에서는 실행하지 않았다.

## 4. 남은 BLOCKED (MID/KEY 또는 규격 확인)
금액 패딩 규칙 · 거래 조회 API · 웹훅 위·변조 검증 · 취소 응답 서명 검증 코드(규격은 확인됨, 활성화 전 추가) · EUC-KR/UTF-8 실제 동작 · 가상계좌/계좌이체 성공 코드 · 비재시도 결과코드 목록 · 앱(Capacitor) 결제창·복귀 방식.
