# 로그인(Supabase Auth) 설정 가이드

로그인 화면(`/login`)이 실제로 동작하려면 아래 설정이 필요해요.

---

## 1. 이메일 로그인 (기본, 5분)

Supabase는 이메일+비밀번호 로그인이 **기본으로 켜져 있어요**. 추가 설정 없이 바로 동작합니다.

다만 확인할 것:
1. Supabase 대시보드 → **Authentication → Providers → Email** 이 Enabled인지 확인
2. 개발 중에는 "Confirm email"을 **꺼두면 편해요** (이메일 인증 없이 바로 로그인 가능)
   - Authentication → Providers → Email → "Confirm email" 토글 OFF
   - 실제 서비스 오픈 때는 다시 켜세요

## 2. 계정/프로필 INSERT 권한 (중요!)

회원가입 시 accounts, profiles, (매니저면) centers, manager_centers에 행을 만들어요.
RLS 때문에 기본으로는 막혀있어서 정책을 열어줘야 합니다.

**→ `auth_policies.sql` 파일 전체를 복사해서 Supabase SQL Editor에 붙여넣고 Run 하세요.**

> 이 문서(.md)의 SQL을 직접 복사하면 설명 문장까지 딸려가서 에러가 납니다.
> 반드시 `auth_policies.sql` 파일을 사용하세요.

> `my_account_id()` 함수는 schema.sql 에 이미 정의돼 있어요 (RLS 섹션).

## 3. 소셜 로그인 (선택, 나중에 해도 됨)

소셜 로그인은 각 제공사 개발자 등록이 필요해요. 이메일 로그인만으로도 개발은 계속 진행할 수 있으니 나중에 해도 됩니다.

### 3-1. 카카오 (가장 간단, 30분)
1. **developers.kakao.com** 가입 → "내 애플리케이션" → 앱 생성
2. 앱 설정 → 플랫폼 → Web 플랫폼 등록 (`http://localhost:3000`)
3. 제품 설정 → **카카오 로그인 활성화** ON
4. Supabase 대시보드 → Authentication → Providers → **Kakao** 클릭 → "Callback URL" 복사
5. 이 URL을 카카오 개발자센터의 카카오 로그인 → **Redirect URI**에 등록
6. 카카오 앱의 **REST API 키** + **Client Secret**(보안 메뉴에서 발급)을 Supabase Kakao 설정에 입력 → Enable
7. 동의항목에서 "닉네임", "카카오계정(이메일)"을 필수 동의로 설정

### 3-2. 애플 (Apple Developer 계정 필요, 유료 연 $99)
1. **developer.apple.com** → Certificates, IDs & Profiles
2. Identifiers → App ID 생성 → "Sign In with Apple" 체크
3. Services ID 생성 (이게 client_id 역할) → 도메인/Return URL에 Supabase Callback URL 등록
4. Keys → "Sign in with Apple" 키 생성 → .p8 파일 다운로드
5. Supabase → Authentication → Providers → **Apple** → Services ID, Team ID, Key ID, .p8 내용 입력 → Enable
   - 애플은 설정이 까다로우니 Supabase 공식 문서(Apple provider) 참고 권장

### 3-3. 네이버 (Supabase 기본 목록에 없음 → 커스텀 설정)
네이버는 Supabase가 기본 제공하지 않아서 두 가지 방법 중 하나로 해야 해요:

**방법 A (권장): 커스텀 OIDC/OAuth**
- 네이버는 표준 OIDC를 완전 지원하진 않아서, 보통 **서버(Edge Function)에서 네이버 토큰을 받아 Supabase 세션으로 교환**하는 방식으로 붙입니다.
- 개발 초기에는 네이버를 빼고 카카오/애플/이메일만 먼저 붙이는 걸 추천해요.

**방법 B: 나중에 네이버 로그인 SDK + Edge Function**
1. **developers.naver.com** → 애플리케이션 등록 → Client ID/Secret 발급
2. Callback URL에 우리 앱 콜백 등록
3. Supabase Edge Function으로 네이버 access token → 사용자정보 조회 → Supabase admin API로 세션 발급
- 이 부분은 코드가 더 필요해서, 실제로 붙일 때 따로 만들어 드릴게요.

> 지금 로그인 화면의 네이버 버튼은 눌러도 "설정 안 됨" 안내만 떠요 — 정상입니다.

## 4. 테스트 방법

```bash
npm run dev
```
1. `localhost:3000/login` 접속
2. 회원가입 탭 → 이름/이메일/비밀번호 입력 → 가입하기
3. (Confirm email 껐다면) 바로 로그인 탭에서 로그인 → 홈으로 이동하면 성공
4. Supabase 대시보드 → Table Editor → `users` 테이블에 프로필 행이 생겼는지 확인

## 문제 생기면
- "이메일 또는 비밀번호가 올바르지 않아요" → 가입한 계정인지, Confirm email 설정 확인
- 프로필 행이 안 생김 → 2번의 RLS 정책 실행했는지 확인
- 소셜 버튼 눌렀는데 에러 → 3번 설정 완료 전이라 정상이에요
- 마이페이지가 안 뜸("사용자 정보를 찾을 수 없어요") → 2번 RLS + reservation_functions.sql 실행 확인
- 예약내역은 뜨는데 수업명이 비어있음 → reservation_functions.sql의 classes/centers 조회 정책 실행 확인
