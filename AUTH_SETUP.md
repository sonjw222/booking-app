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

### 3-2. 애플 — 네이티브(Sign in with Apple) 방식, 콘솔 설정 대부분 완료됨

> 2026-08-13에는 $99/년 가입비 때문에 출시 직전까지 의도적으로 보류했었지만, Apple
> Developer Program 가입이 완료됐다(대표님 확인, 2026-09-14). **2026-09-14 릴리스 폴리시
> 배치에서 아키텍처를 웹 OAuth → 네이티브로 전환**했다 — 처음엔 구글처럼
> `supabase.auth.signInWithOAuth({provider:"apple"})`를 쓰려 했으나, 이미 설정해둔 Supabase
> Apple Provider 값(Client IDs = 앱 Bundle ID `com.mwhabit.app`, Secret Key = 비어 있음)이
> 웹 OAuth가 아니라 **네이티브 플로우** 설정과 정확히 일치했다(Supabase 공식 문서: 웹 OAuth는
> 별도 Services ID + .p8로 서명한 JWT 시크릿이 반드시 필요 — 이 상태로 `signInWithOAuth`를
> 부르면 토큰 교환이 실패한다). 네이티브로 가면 Services ID 자체가 필요 없고, **6개월마다
> OAuth 시크릿을 재발급해야 하는 운영 부담도 아예 없어진다**(Supabase 공식 문서: "Native-only
> implementations don't require secret key rotation").
>
> 코드: `ios/App/App/AppleSignInPlugin.swift`(신규 로컬 커스텀 Capacitor 플러그인 —
> `ASAuthorizationAppleIDProvider`를 직접 감쌈, npm 서드파티 의존성 없음 — 기존
> `FcmTokenPlugin.swift`와 동일한 선례), `lib/appleAuth.ts`(nonce 생성/해시 +
> `supabase.auth.signInWithIdToken()` 호출), `app/login/page.tsx`의 `handleSocial("apple")`,
> `lib/authAccount.ts`의 `ensureAccountForCurrentUser()`(계정 부트스트랩, 애플 최초 인증
> 이름 처리 포함). **iOS 네이티브 앱에서만 동작** — 웹 브라우저/Android에서 애플 버튼을
> 누르면 "Apple 로그인은 현재 iOS 앱에서만 지원돼요" 안내만 뜨고 앱이 죽지 않는다(이미
> 구현됨 — `ASAuthorizationAppleIDProvider` 자체가 iOS/macOS 전용 네이티브 API라 웹엔
> 대응하는 게 없고, 지금 Supabase 설정으로는 웹 OAuth 경로도 어차피 동작하지 않는다).

**애플의 이름 제공 정책(중요)**: 애플은 **최초 1회 인증에서만** 사용자 이름을 내려준다 — 게다가
네이티브 플로우에서는 `user_metadata`가 아니라 `ASAuthorizationAppleIDCredential.fullName`이라는
완전히 별도의 필드로, 딱 한 번만 온다. `lib/appleAuth.ts`가 `signInWithIdToken()` 호출
**전**에 세션스토리지에 스태시하고(`lib/authAccount.ts`의 `stashAppleFullName`), 세션이 생긴
뒤 실행되는 `ensureAccountForCurrentUser()`가 계정을 **처음 만들 때만** 그 값을 최우선으로
읽는다(`consumeAppleFullName()` — 기존 마케팅 동의 스태시와 동일 패턴 재사용, 비동기
타이밍 레이스에 안전). 최초 인증 시점을 놓치면(예: 테스트 후 계정 생성 실패) 그 사용자의
이름을 다시 받을 방법이 없다 — 사용자가 설정에서 앱 권한을 철회했다가 재허용하면 다시 내려온다.

**알려진 미해결 위험(조사만 함, 이번 배치 범위 밖)**: 애플의 "Hide My Email"(비공개 릴레이
이메일, `*@privaterelay.appleid.com`)을 쓰면 `lib/accountLinking.ts`의
`checkMergeableAccountByEmail()`(실제 이메일 일치로 기존 계정을 찾는 자동 병합 제안)가
동작하지 않는다 — 릴레이 이메일은 기존에 가입한 실제 이메일과 절대 일치하지 않기 때문이다.
즉 실제 이메일로 이미 가입한 사용자가 "이메일 가리기"를 켠 채 애플로 로그인하면 자동
병합 제안 없이 별도 계정이 새로 만들어질 수 있다. 수동 연동(설정 화면의 연동 코드 입력,
`createAccountLinkCode`/`linkAccountsByCode`)은 계속 쓸 수 있으므로 완전히 막힌 건 아니다.
Supabase 공식 문서도 이 케이스를 다루지 않는다 — 실사용 데이터로 얼마나 자주 발생하는지
확인 후 필요하면 별도 과제로 다룰 것(`docs/TODO.md` 참고).

**남은 콘솔 설정(이미 완료된 항목 체크 포함)**:

1. ✅ Apple Developer → App ID(`com.mwhabit.app`) → "Sign In with Apple" capability 활성화 (완료)
2. ✅ Xcode target(`ios/App/App.xcodeproj`) → Signing & Capabilities → "Sign in with Apple" 추가 (완료)
   — 이게 되면 `App.entitlements`에 `com.apple.developer.applesignin`(배열 값 `["Default"]`)이
   자동으로 들어간다(Apple 공식 entitlement 키). 이 파일은 저장소에 커밋되지 않으므로
   (User가 로컬/Xcode에서 관리) Claude가 직접 확인/수정하지 않음 — Xcode에서 capability가
   켜져 있으면 이미 맞게 들어가 있을 것.
3. ✅ Supabase → Authentication → Providers → Apple → Enable ON, Client IDs =
   `com.mwhabit.app`, Secret Key = 비워둠, "Allow users without an email" = OFF (완료 —
   네이티브 플로우에 정확히 맞는 값. **Services ID/​.p8 키/​6개월 시크릿 로테이션은 필요
   없음** — 웹 OAuth 전용 요구사항이라 네이티브에서는 해당 없음)
4. ❌ **아직 안 됨 — 필요**: 재빌드/재서명. `ios/App/App/AppleSignInPlugin.swift`가 신규
   파일이라 Xcode에서 `npx cap sync ios` 후 프로젝트를 다시 열어(또는 Xcode가 자동 인식)
   빌드해야 반영된다. 새 provisioning profile 재생성이 필요할 수도 있음(capability 추가
   직후 흔한 케이스 — Xcode가 "Automatically manage signing"이면 보통 자동 처리됨).
5. 실기기 테스트 — 시뮬레이터는 Apple ID 로그인이 안 되는 경우가 많아(Apple 계정 자체가
   시뮬레이터에 로그인돼 있어야 함) **실기기 권장**.

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
