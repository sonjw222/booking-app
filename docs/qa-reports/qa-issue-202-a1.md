# QA 보고서 — Issue #202 (시도 1)

- Issue: [AI-QA-SMOKE] DEV 브라우저 QA 자동화 검증
- 결과: **✅ 실행한 시나리오 모두 통과**
- 브랜치: `qa/issue-202-a1` / 기준 커밋 `342e48e411`
- 범위: 뷰포트 [320, 360, 390]px, 테마 ['dark', 'light'], 그룹 ['smoke']
- 소요: 39초, Claude 비용 약 $0.00 (상한 $3.0)

## 안전 검증
- ✅ 운영 프로젝트 참조·키 없음(.env.test.local)
- ✅ DEV 프로젝트 URL/anon 키 일치
- ✅ DEV Supabase 연결
- ✅ DEV 스키마(필수 테이블 존재, 읽기 전용 확인)
- ✅ 서버 번들에 운영 참조/service_role 없음(브라우저 실행 전)

## 실행한 시나리오
### 1차 실행: 총 36개 · 통과 36 · 실패 0 · 건너뜀 0
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

## 미실행(통과로 보고하지 않음)
- 없음
- 위에 적히지 않은 화면/기능(결제 실결제, 소셜 로그인, 푸시, 네이티브 앱 등)은 이 QA 범위가 아닙니다.

> 자동 QA 에이전트가 만든 Draft 보고서입니다. 사람이 검토하기 전에는 병합하지 마세요.
