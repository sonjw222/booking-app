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

### 3-0. 구글 (완료 — Supabase 기본 제공 Google provider 그대로 사용)

구글은 이메일/프로필이 "민감하지 않은 기본 스코프"라 카카오 같은 권한 제한이 없다. Supabase
기본 제공 Google provider를 그대로 쓰면 된다(커스텀 Edge Function 불필요).

1. **console.cloud.google.com** → 새 프로젝트 생성(사업자 필요 없음, 무료 — 결제 계정 등록도
   필요 없다)
2. **API 및 서비스 → OAuth 동의 화면**
   - 대상: **외부** 선택
   - 앱 이름/지원 이메일/개발자 연락처 이메일 입력 → 저장
   - "테스트" 상태로 시작됨(등록한 테스트 사용자만 로그인 가능) — 실제 서비스 오픈 전까지는
     이 상태로 개발 진행 가능
3. **사용자 인증 정보 → OAuth 클라이언트 만들기**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 승인된 리디렉션 URI: Supabase 대시보드 → Authentication → Providers → **Google**의
     Callback URL을 복사해서 등록
     ```
     https://bxntqggkfwnhcczsbqtj.supabase.co/auth/v1/callback
     ```
4. 발급된 **클라이언트 ID**, **클라이언트 보안 비밀번호**를 그 자리에서 바로 복사(창을 닫으면
   보안 비밀번호는 다시 못 봄) → Supabase 대시보드 Google Provider 설정에 붙여넣고 Enable → Save

> **알려진 제약(수정 불가, 기능엔 영향 없음)**: 구글 로그인 동의 화면에 앱 이름 대신
> `xxxxx.supabase.co 서비스로 로그인`이 표시된다. Supabase의 공용 도메인을 거쳐 인증이
> 이뤄지는 구조상 발생하는 것으로, 구글의 "승인된 도메인"에는 본인이 소유·인증한 도메인만
> 등록 가능해 `supabase.co`를 직접 추가할 수 없다. Supabase 유료 플랜의 커스텀 도메인을
> 설정하거나, 카카오/네이버처럼 완전 커스텀 OAuth 흐름으로 전환해야 해결되며 실사용 서비스
> 오픈 시점에 재검토할 사항으로 남겨둔다.

### 3-1. 카카오 — Supabase 기본 제공 Kakao provider 사용 불가, 커스텀 Edge Function으로 구현 완료

> Supabase의 기본 제공 Kakao provider(`signInWithOAuth({ provider: "kakao" })`)는 서버 쪽에서
> `account_email` 스코프를 무조건 같이 요청한다. 이 프로젝트의 카카오 앱은 이메일 항목이
> **"권한없음"**(개인 개발자는 "비즈니스 앱 전환"을 해야 요청 가능 — 사업자 없이도 개인
> 자격으로 전환 가능한지는 카카오 정책이라 확인 안 됨) 상태라 그대로 쓰면
> `"Invalid scope: account_email"`로 거부된다. 네이버와 동일한 방식(커스텀 Edge Function이
> Authorization Code 흐름을 직접 완결)으로 우회해 구현했다 — 코드는 이미 완성돼 있고,
> 아래 콘솔 설정만 하면 된다.
>
> 코드: `lib/kakaoAuth.ts`, `app/login/kakao-callback/page.tsx`,
> `supabase/functions/kakao-login/index.ts`. 정체성 정책은 네이버와 동일(합성 이메일
> `kakao-<카카오id>@kakao.socialauth.invalid`, DEC-004 참고).

**설정 순서**

1. **developers.kakao.com** 가입 → "내 애플리케이션" → 앱 생성
   - "회사명"은 사업자 없어도 본인 이름/프로젝트 이름 아무거나 입력 가능(실제 사업자 검증 안 함)
   - "앱 대표 도메인"은 `localhost` 등 로컬 주소를 거부하므로 **비워두고 넘어가면 된다**(선택 항목)
2. **제품 설정 → 카카오 로그인 → 일반** → "사용 설정" **ON**
3. **동의항목**에서 **"닉네임"만 필수 동의**로 설정(동의 목적 예: "회원가입 시 표시 이름으로
   사용하기 위해 수집합니다"). **"카카오계정(이메일)"은 "권한없음"이라 설정 자체가 안 되니
   그냥 건너뛴다** — 우리 구현은 이메일을 요청하지 않아서 문제없다.
4. **앱 설정 → 플랫폼 키** → `Default Rest API Key` 카드 오른쪽 **⋮ → 수정** 클릭
   - **"카카오 로그인 리다이렉트 URI"**에 등록:
     ```
     http://localhost:3000/login/kakao-callback
     ```
     (배포 후엔 실제 도메인의 같은 경로도 추가)
   - **REST API 키** 값을 복사해둔다(= Client ID)
5. 같은 "플랫폼 키" 페이지에서 **"클라이언트 시크릿"** 클릭 → **"카카오 로그인"** 줄(⚠
   "비즈니스 인증" 줄 아님, 바로 아래 있어서 헷갈리기 쉬움)의 **코드**를 복사, **활성화 ON**
   확인(= Client Secret)
6. Edge Function 배포 (네이버와 같은 방식)
   ```bash
   supabase functions deploy kakao-login
   supabase secrets set KAKAO_CLIENT_ID=복사한_REST_API_키 KAKAO_CLIENT_SECRET=복사한_시크릿_코드
   ```
   - **반드시 카카오 콘솔에서 직접 복사-붙여넣기**로 진행할 것 — `I`(대문자 아이)와
     `l`(소문자 엘)이 거의 구분 안 되는 폰트라 손으로 옮겨적으면 `invalid_client`(KOE010)로
     실패하기 쉽다(실제로 겪은 문제).
7. 앱의 `.env.local`
   ```
   NEXT_PUBLIC_KAKAO_CLIENT_ID=복사한_REST_API_키
   ```
8. 배포 환경에도 같은 `NEXT_PUBLIC_KAKAO_CLIENT_ID` 등록 + 카카오 콘솔 Redirect URI에
   실제 배포 도메인 추가

### 3-2. 애플 (Apple Developer 계정 필요, 유료 연 $99) — 출시 직전으로 의도적 보류(2026-08-13)

> $99/년 가입비가 곧 Sign in with Apple 사용 조건이라, 지금 미리 가입해도 얻는 게 없이 구독만
> 먼저 시작된다. 실제 서비스 출시가 가까워져 Apple Developer 계정을 만드는 시점에 아래 절차를
> 함께 진행하기로 결정함(`docs/TODO.md` P2-1). 앱 코드(로그인 버튼, 콜백 처리)는 이미 완성돼
> 있어 계정만 만들면 바로 이어서 설정할 수 있다.

1. **developer.apple.com** → Certificates, IDs & Profiles
2. Identifiers → App ID 생성 → "Sign In with Apple" 체크
3. Services ID 생성 (이게 client_id 역할) → 도메인/Return URL에 Supabase Callback URL 등록
4. Keys → "Sign in with Apple" 키 생성 → .p8 파일 다운로드
5. Supabase → Authentication → Providers → **Apple** → Services ID, Team ID, Key ID, .p8 내용 입력 → Enable
   - 애플은 설정이 까다로우니 Supabase 공식 문서(Apple provider) 참고 권장

### 3-3. 네이버 (Supabase 기본 목록에 없음 → Edge Function 구현 완료, 설정만 하면 됨)

네이버는 Supabase가 기본 제공하는 OAuth provider가 아니라서, **서버(Edge Function)에서 네이버
access token을 받아 Supabase 세션으로 교환**하는 방식을 씁니다. 앱 코드(로그인 화면, 콜백
화면, Edge Function)는 이미 다 만들어져 있어요 — 아래 설정만 하면 동작합니다.

- 코드: `app/login/page.tsx`(`handleSocial("naver")`), `lib/naverAuth.ts`,
  `app/login/naver-callback/page.tsx`, `supabase/functions/naver-login/index.ts`
- 정체성 정책: 네이버가 주는 실제 이메일이 아니라 네이버 고유 회원번호로 만든 합성 이메일
  (`naver-<네이버id>@naver.socialauth.invalid`)을 계정 식별자로 씁니다 — 이미 다른 방식으로
  가입된 계정과 이메일이 같다는 이유만으로 자동 연동되지 않게 하기 위해서예요(DEC-004,
  `docs/08_Decision_Log.md`).

**설정 순서**

1. **developers.naver.com** 가입 → "Application" → 애플리케이션 등록
   - 사용 API: "네이버 로그인" 추가
   - 제공 정보 선택: **이메일, 이름**(필수 동의 권장 — email이 없으면 로그인은 되지만
     `ensureAccountForCurrentUser()`가 표시용 이름을 프로필 메타데이터에서만 가져옵니다)
   - 서비스 URL: `http://localhost:3000` (배포 후엔 실제 도메인 추가)
   - Callback URL: `http://localhost:3000/login/naver-callback` (배포 후엔 실제 도메인의
     같은 경로도 추가 — `<도메인>/login/naver-callback`)
2. 발급된 **Client ID**, **Client Secret** 확인
3. Supabase CLI로 Edge Function 배포 (최초 1회 `supabase login`, `supabase link` 필요)
   ```bash
   supabase functions deploy naver-login
   supabase secrets set NAVER_CLIENT_ID=발급받은값 NAVER_CLIENT_SECRET=발급받은값
   ```
   - `SUPABASE_URL`은 Supabase가 Edge Function에 자동으로 넣어줘서 따로 설정할 필요 없어요.
   - `SUPABASE_SERVICE_ROLE_KEY`는 대부분의 Supabase 프로젝트에 기본 secret으로 이미
     들어있습니다(없다면 Project Settings → API → service_role 값을 같은 방식으로 `set`).
4. 앱의 `.env.local`(브라우저에 노출되는 값이라 Client ID만, Secret은 절대 넣지 마세요)
   ```
   NEXT_PUBLIC_NAVER_CLIENT_ID=발급받은Client ID
   ```
5. 배포 환경(Vercel 등)에도 같은 `NEXT_PUBLIC_NAVER_CLIENT_ID`를 환경변수로 등록하고,
   네이버 애플리케이션의 서비스 URL/Callback URL에 실제 배포 도메인을 추가하세요.

> 위 설정 전에는 로그인 화면의 네이버 버튼을 눌러도 "설정 안 됨" 안내만 떠요 — 정상입니다.

## 4. 계정 탈퇴(소프트 삭제)

`/settings/account` 화면의 "계정 탈퇴"가 동작하려면 아래 두 가지가 필요해요(코드는 이미
만들어져 있음 — `app/settings/account/page.tsx`, `lib/accountDeletion.ts`,
`supabase/functions/delete-account/index.ts`, `add_account_deactivation.sql`).

1. **`add_account_deactivation.sql` 전체를 Supabase SQL Editor에서 실행** — `accounts`에
   `deactivated_at` 컬럼을 추가합니다. (기존 데이터를 지우지 않는 소프트 삭제라 안전하지만,
   운영 DB에 실행하기 전에는 항상 먼저 확인하세요 — CLAUDE.md 규칙 3)
2. Edge Function 배포 (네이버 로그인과 같은 방식)
   ```bash
   supabase functions deploy delete-account
   ```
   - 별도 secret은 필요 없어요 — `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`
     모두 대부분의 프로젝트에 기본으로 들어있습니다(네이버 로그인 설정에서 이미 등록했다면 그대로 재사용됨).

탈퇴 처리는 실제 행을 지우지 않고 `accounts.deactivated_at`을 채운 뒤 그 사용자를
Supabase Auth에서 밴(재로그인 차단)합니다. 예약/구매/결제 이력은 그대로 남아요.

> ⚠️ 소셜 로그인 계정의 탈퇴 재인증은 아직 확인 문구 입력 수준입니다(provider 재로그인
> 왕복까지는 미구현, `docs/TODO.md` P1-18 참고).

## 5. 테스트 방법

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
