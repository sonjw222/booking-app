# QA 보고서 — Issue #207 (시도 1)

- Issue: [AI-QA-DEEP] 모바일 다크모드·예약·관리자 심화 QA
- 결과: **✅ 실행한 시나리오 모두 통과**
- 브랜치: `qa/issue-207-a1` / 기준 커밋 `342e48e411`
- 범위: 뷰포트 [320, 360, 390]px, 테마 ['dark', 'light'], 그룹 ['smoke', 'member', 'admin', 'reservation']
- 소요: 306초, Claude 비용 약 $0.00 (상한 $3.0)

## 안전 검증
- ✅ 운영 프로젝트 참조·키 없음(.env.test.local)
- ✅ DEV 프로젝트 URL/anon 키 일치
- ✅ DEV Supabase 연결
- ✅ DEV 스키마(필수 테이블 존재, 읽기 전용 확인)
- ✅ DEV 테스트 계정 4개 로그인 가능·테스트용 이메일
- ✅ 서버 번들에 운영 참조/service_role 없음(브라우저 실행 전)

## 실행한 시나리오
### 1차 실행: 총 92개 · 통과 92 · 실패 0 · 건너뜀 0
- ✅ `smoke-w320-dark` 공개 화면 /: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w320-dark` 공개 화면 /login: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w320-dark` 공개 화면 /about: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w320-dark` 공개 화면 /search: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w320-dark` 공개 화면 /reset-password: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w320-dark` 로그인 화면: 입력 폼이 보이고 선택한 색상 테마가 적용됨
- ✅ `smoke-w320-light` 공개 화면 /: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w320-light` 공개 화면 /login: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w320-light` 공개 화면 /about: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w320-light` 공개 화면 /search: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w320-light` 공개 화면 /reset-password: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w320-light` 로그인 화면: 입력 폼이 보이고 선택한 색상 테마가 적용됨
- ✅ `smoke-w360-dark` 공개 화면 /: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-dark` 공개 화면 /login: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-dark` 공개 화면 /about: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-dark` 공개 화면 /search: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-dark` 공개 화면 /reset-password: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-dark` 로그인 화면: 입력 폼이 보이고 선택한 색상 테마가 적용됨
- ✅ `smoke-w360-light` 공개 화면 /: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-light` 공개 화면 /login: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-light` 공개 화면 /about: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-light` 공개 화면 /search: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-light` 공개 화면 /reset-password: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w360-light` 로그인 화면: 입력 폼이 보이고 선택한 색상 테마가 적용됨
- ✅ `smoke-w390-dark` 공개 화면 /: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w390-dark` 공개 화면 /login: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w390-dark` 공개 화면 /about: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w390-dark` 공개 화면 /search: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w390-dark` 공개 화면 /reset-password: 로드·가로 넘침 없음·DEV 연결만
- ✅ `smoke-w390-dark` 로그인 화면: 입력 폼이 보이고 선택한 색상 테마가 적용됨
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
- ✅ `e2e-repo` TEST4: 신규 수업 → 사용 가능 수강권 없음 → 그 자리에서 구매 → 새로고침 포함 즉시 사용 가능 → 예약 성공 (실브라우저)
- ✅ `e2e-repo` TEST5: 신규 수업(모든 수강권 허용)에서도 goods는 사용 가능한 수강권 목록에 절대 안 보임 (실브라우저)
- ✅ `e2e-repo` TEST6(대조군): 기존 방식(admin client 직접 insert)으로 만든 수업도 계속 정상 예약 가능 (실브라우저)
- ✅ `e2e-repo` 요일별 개별 지정(perDayMode) 반복수업 등록 — RPC 1회로 모든 요일이 정확히 반영됨 (실브라우저)
- ✅ `e2e-repo` 마이페이지 → 내 정보 관리 진입, 새 비밀번호 확인 불일치 시 막힌다 (실브라우저)
- ✅ `e2e-repo` 내 정보 관리 — 6자 미만 비밀번호는 막힌다 (실브라우저)
- ✅ `e2e-repo` 결제 화면: 비로그인으로 결제 시도 → 로그인 → 같은 상품의 결제 화면으로 정확히 복귀 (실브라우저)

## 미실행(통과로 보고하지 않음)
- 없음
- 위에 적히지 않은 화면/기능(결제 실결제, 소셜 로그인, 푸시, 네이티브 앱 등)은 이 QA 범위가 아닙니다.

> 자동 QA 에이전트가 만든 Draft 보고서입니다. 사람이 검토하기 전에는 병합하지 마세요.
