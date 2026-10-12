# QA 보고서 — Issue #204 (시도 2)

- Issue: [AI-QA-FUNC] DEV 예약·취소·관리자·회원 UI 브라우저 기능 QA
- 결과: **❌ 실패가 남아 있음(수정 실패 또는 범위 밖)**
- 브랜치: `qa/issue-204-a2` / 기준 커밋 `342e48e411`
- 범위: 뷰포트 [360, 390]px, 테마 ['light'], 그룹 ['smoke', 'member', 'admin', 'reservation']
- 소요: 499초, Claude 비용 약 $0.16 (상한 $3.0)

## 안전 검증
- ✅ 운영 프로젝트 참조·키 없음(.env.test.local)
- ✅ DEV 프로젝트 URL/anon 키 일치
- ✅ DEV Supabase 연결
- ✅ DEV 스키마(필수 테이블 존재, 읽기 전용 확인)
- ✅ DEV 테스트 계정 4개 로그인 가능·테스트용 이메일
- ✅ 서버 번들에 운영 참조/service_role 없음(브라우저 실행 전)

## 실행한 시나리오
### 1차 실행: 총 68개 · 통과 67 · 실패 1 · 건너뜀 0
- ✅ `smoke-w360-light` 공개 화면 /: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-light` 공개 화면 /login: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-light` 공개 화면 /about: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-light` 공개 화면 /search: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-light` 공개 화면 /reset-password: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-light` 로그인 화면: 입력 폼이 보이고 선택한 색상 테마가 적용됨
- ✅ `smoke-w390-light` 공개 화면 /: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w390-light` 공개 화면 /login: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w390-light` 공개 화면 /about: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w390-light` 공개 화면 /search: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w390-light` 공개 화면 /reset-password: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w390-light` 로그인 화면: 입력 폼이 보이고 선택한 색상 테마가 적용됨
- ✅ `e2e-setup` authenticate as manager (TEST_MANAGER_A)
- ✅ `e2e-setup` authenticate as member (TEST_USER_A)
- ✅ `e2e-setup` authenticate as member (TEST_USER_B)
- ✅ `e2e-repo` 관리자: 예약자 출석 → 결석(노쇼) → 되돌리기, 취소된 예약은 변경 불가 (그룹 수업, 실브라우저)
- ✅ `e2e-repo` 관리자: 대기(waitlisted) 예약은 출석/결석 버튼이 보이지 않는다 (그룹 수업, 실브라우저)
- ✅ `e2e-repo` 관리자: 프라이빗 수업에서도 출석/결석 처리가 동일하게 동작한다 (실브라우저)
- ✅ `e2e-repo` 관리자: 검색으로 특정 pass 1개만 선택 → 저장 → 재진입 시 선택값 유지 → 회원 화면엔 그 pass만 표시 (실브라우저)
- ✅ `e2e-repo` 관리자: 특정 pass 여러 개 허용 → 지정된 것만 표시, 나머지는 제외 (실브라우저)
- ✅ `e2e-repo` 관리자: 전체 선택(전체 허용으로 전환) → 회원 화면에 보유한 모든 pass 표시, goods는 절대 표시 안 됨 (실브라우저)
- ✅ `e2e-repo` 프라이빗 수업에서도 예약 가능 수강권 선택이 동일하게 동작한다 (실브라우저)
- ✅ `e2e-repo` 타 센터 pass는 관리자 선택 목록/검색 결과에 절대 섞이지 않는다 (실브라우저)
- ✅ `e2e-repo` 휴무일 생성→회원화면 예약차단 확인→삭제→새로고침→기존/신규 수업 예약 가능 (실브라우저 end-to-end)
- ✅ `e2e-repo` B: schedule rule과 일치하는 수업에서는 그 조건의 pass가 사용 가능하다 (모든 수강권 허용, 실브라우저)
- ✅ `e2e-repo` D+F(F2 정책): 특정 수강권 직접 지정해도 schedule rule 불일치면 회원은 그 수강권을 쓸 수 없다 (실브라우저)
- ✅ `e2e-repo` J(F2 정책): 방금 새로 발급된 membership도 예약조건 불일치면 직접 지정돼 있어도 쓸 수 없다 (실브라우저)
- ✅ `e2e-repo` TEST1: 관리자 UI로 신규 수업(모든 수강권 허용) 생성 → 회원 기존 pass 표시 → 예약 성공 (실브라우저)
- ✅ `e2e-repo` TEST2: 관리자 UI로 신규 수업(특정 pass 1개만 허용) 생성 → 해당 pass만 표시 → 예약 성공 (실브라우저)
- ❌ `e2e-repo` TEST4: 신규 수업 → 사용 가능 수강권 없음 → 그 자리에서 구매 → 새로고침 포함 즉시 사용 가능 → 예약 성공 (실브라우저)
- ✅ `e2e-repo` TEST5: 신규 수업(모든 수강권 허용)에서도 goods는 사용 가능한 수강권 목록에 절대 안 보임 (실브라우저)
- ✅ `e2e-repo` TEST6(대조군): 기존 방식(admin client 직접 insert)으로 만든 수업도 계속 정상 예약 가능 (실브라우저)
- ✅ `e2e-repo` 요일별 개별 지정(perDayMode) 반복수업 등록 — RPC 1회로 모든 요일이 정확히 반영됨 (실브라우저)
- ✅ `e2e-repo` 마이페이지 → 내 정보 관리 진입, 새 비밀번호 확인 불일치 시 막힌다 (실브라우저)
- ✅ `e2e-repo` 내 정보 관리 — 6자 미만 비밀번호는 막힌다 (실브라우저)
- ✅ `e2e-repo` 결제 화면: 비로그인으로 결제 시도 → 로그인 → 같은 상품의 결제 화면으로 정확히 복귀 (실브라우저)
- ✅ `e2e-repo` 장바구니 담기: 비로그인으로 센터 상세에서 '담기' 시도 → 로그인 → 같은 센터 화면으로 복귀 (실브라우저)
- ✅ `e2e-repo` 예약 화면: 비로그인으로 /reservation 진입 → 로그인 → /reservation으로 복귀 (실브라우저)
- ✅ `e2e-repo` next 없이 곧바로 /login 방문 후 로그인하면 여전히 홈으로 이동한다 (회귀 확인, 실브라우저)
- ✅ `e2e-repo` 로그인 상태 유지 체크 해제 시 세션이 localStorage가 아닌 sessionStorage에 저장된다 (실브라우저)
- ✅ `e2e-repo` 로그인 상태 유지 체크(기본값) 시 세션이 localStorage에 저장된다 (실브라우저)
- ✅ `e2e-repo` 이메일 입력 후 재설정 요청 — Supabase 응답을 화면에 그대로 반영한다 (실브라우저)
- ✅ `e2e-repo` 이메일 미입력 시 클라이언트 유효성 검사로 막힌다 (실브라우저)
- ✅ `e2e-repo` 로그인 화면의 '비밀번호를 잊으셨나요?' 링크로 이동한다 (실브라우저)
- ✅ `e2e-repo` OAuth 콜백 실패(#error=...)로 홈에 도착하면 로그인 화면으로 안내 문구와 함께 되돌아간다 (실브라우저)
- ✅ `e2e-repo` 수업 시작 후 예약 시도 → 실패 확인 (실브라우저)
- ✅ `e2e-repo` 수업 시작 후 취소 시도 → 실패 확인 (실브라우저)
- ✅ `e2e-repo` D: 강사 1명 — 메타 텍스트에 강사명이 표시되고, 별도 버튼에 예약 인원이 표시된다
- ✅ `e2e-repo` F: 강사 없음 — 시간 텍스트에 불필요한 구분자가 없다
- ✅ `e2e-repo` A: 강사 1명 — 센터명과 같은 줄에 '센터명 · 강사명' 형태로, 별도 줄이 아니다
- ✅ `e2e-repo` 예약 확인 상세에는 목록과 달리 담당 강사 명단이 줄임 없이 보인다(2026-08-12 피드백)
- ✅ `e2e-repo` C: 강사 없음 — 센터명만 표시되고 불필요한 구분자가 없다
- ✅ `e2e-repo` 대기 인원 표시 설정 ON/OFF에 따라 .class-count의 '대기 N'이 나타나고 사라진다 (실브라우저)
- ✅ `e2e-repo` 예약마감 2시간 전 — 3시간 뒤 수업은 예약 성공 (실브라우저)
- ✅ `e2e-repo` 예약마감 2시간 전 — 1시간 뒤 수업은 예약 실패 (실브라우저)
- ✅ `e2e-repo` 운영설정 예약마감(관리자 화면 저장) — 마감이 안 지난 날의 수업은 성공, 이미 지난 날의 수업은 실패 (실브라우저 end-to-end)
- ✅ `e2e-repo` 예약 오픈 7일 전 — 8일 뒤 수업은 아직 오픈 전(예약 불가) (실브라우저)
- ✅ `e2e-repo` 예약 오픈 7일 전 — 6일 뒤 수업은 오픈 기한 안쪽(예약 가능) (실브라우저)
- ✅ `e2e-repo` 취소기한 2시간 — 3시간 뒤 수업은 1시간 전이라 취소 성공 (실브라우저 end-to-end)
- ✅ `e2e-repo` 취소기한 2시간 — 1시간 뒤 수업은 이미 지나서 취소 실패 (실브라우저 end-to-end)

## 미실행(통과로 보고하지 않음)
- 없음
- 위에 적히지 않은 화면/기능(결제 실결제, 소셜 로그인, 푸시, 네이티브 앱 등)은 이 QA 범위가 아닙니다.

## 최초 실패 시나리오
- `e2e-repo` TEST4: 신규 수업 → 사용 가능 수강권 없음 → 그 자리에서 구매 → 새로고침 포함 즉시 사용 가능 → 예약 성공 (실브라우저)
  - 오류: `Error: expect(locator).toBeVisible() failed  Locator: locator('text=테스트 결제가 완료됐어요') Expected: visible Timeout: 20000ms Error: element(s) not found  Call log:   - Expect "toBeVisible" with timeout 20000ms   - waiting for locator('text=테스트 결제가 완료됐어요') `

증거(스크린샷/trace)는 로컬 `qa_artifacts` 폴더에 보관됩니다(저장소에는 커밋하지 않음):
- `/Users/sonjw/Documents/mwhabit-automation/qa_artifacts/issue-204/a2`

## 원인 분석 (Claude Code)
지금은 결제 완료 문구 단언이 왜 실패했는지 코드로 확인하고 있고, 분석은 거의 끝났습니다.

**원인**

TEST4는 `.checkout-pay-btn`을 누르면 Mock 결제가 바로 확정되고 "테스트 결제가 완료됐어요"가 뜰 것이라고 가정합니다(`tests/e2e/admin/new-class-creation.spec.ts:354-356`). 하지만 앱이 틀린 것은 아닙니다. 이 가정이 실행 환경과 맞지 않습니다.

- `lib/payments/PaymentProviderFactory.ts:28`의 `PG_CHECKOUT_ENABLED`는 `NEXT_PUBLIC_PG_CHECKOUT_ENABLED === "true"`일 때만 켜집니다. 이 환경에서는 꺼져 있었을 가능성이 높습니다.
- 꺼져 있으면 `app/checkout/page.tsx:103`에서 기본 결제수단이 `"direct"`(직접결제)가 됩니다. 카드 등 PG 수단은 화면에 노출되지 않습니다.
- `direct`로 결제하면 `handlePay`(`page.tsx:309-345`)가 Mock/PG를 호출하지 않습니다. 주문만 pending으로 접수하고 `pendingManualPayment=true`로 완료 화면을 띄웁니다. 문구는 "주문이 접수됐어요"(`page.tsx:464-466`)입니다. 수강권도 발급되지 않고 자동 복귀도 하지 않습니다.
- 그래서 "테스트 결제가 완료됐어요"는 나타나지 않았습니다. 이 문구는 `resolveProviderName()==="mock"`이면서 PG 경로로 결제가 `paid`가 된 경우에만 나옵니다.
- `NEXT_PUBLIC_PAYMENT_PROVIDER`가 `toss`로 설정된 환경에서도 같은 단언이 실패합니다. 이 경우 문구는 "결제가 완료됐어요"이고, 카드를 누르면 실제 토스 창으로 이동합니다. 같은 저장소의 `member-full-lifecycle.spec.ts:174-187` 주석이 이 상황을 언급합니다.
- 실제 환경값은 `.env*`를 읽지 않아 확인하지 못했습니다. 위 내용은 코드 기준 추정입니다.

**수정 가능 여부**

- 근본 해결은 QA 실행 환경에 `NEXT_PUBLIC_PG_CHECKOUT_ENABLED=true`와 `NEXT_PUBLIC_PAYMENT_PROVIDER=mock`을 설정하는 것입니다. 둘 다 설정/환경 변수라 이 작업의 수정 범위 밖입니다.
- `app/`이나 `tests/`만 고치는 방법은 모두 TEST4의 목적을 훼손합니다.
  - 테스트에서 "직접결제"를 고르면 수강권이 발급되지 않아, "구매 직후 새로고침해도 바로 사용 가능"이라는 핵심 검증이 사라집니다.
  - 테스트에서 admin client로 `fulfill_order` RPC를 호출해 발급시키면 구매 흐름 자체를 검증하지 않게 됩니다. 사실상 단언 약화이고, RPC/결제 로직에 가까운 영역입니다.
  - 앱의 PG 게이트를 우회하게 고치면 결제 핵심 로직 변경입니다.
- 대안으로 테스트 시작 시 `process.env`를 보고 PG 게이트가 꺼져 있으면 skip하게 할 수는 있습니다. 하지만 skip은 규칙상 하지 않습니다.

수정 대상 파일: 없음. 환경 설정(QA/CI의 `NEXT_PUBLIC_PG_CHECKOUT_ENABLED`, `NEXT_PUBLIC_PAYMENT_PROVIDER`)만 바꾸면 됩니다.

FIXABLE: no

## 수정 보류
- 사유: 분석 결과 자동 수정 범위 밖(FIXABLE: no) — 사람 검토 필요

> 자동 QA 에이전트가 만든 Draft 보고서입니다. 사람이 검토하기 전에는 병합하지 마세요.
