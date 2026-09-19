# EPIC 03 — Authentication

Status: Partially Implemented
Version: 1.1.0
Current-State Source: `app/login/page.tsx`, Supabase auth calls in `app/**` and `lib/**`, auth/RLS SQL
Target-State Status: Recovery and linking require product decisions
Last Updated: 2026-07-31

## 1. Goal

Supabase Auth를 인증 기반으로 유지하면서 Account/Profile/Center Staff Assignment를 안전하게 연결한다.

## 2. Current State

- 이메일/비밀번호 회원가입과 로그인
- 이메일 인증을 전제로 한 가입 안내
- Supabase Auth user와 `accounts.auth_id` 연결
- 가입 시 대표 `profiles` 생성
- 매니저 가입 시 pending Center 생성, `manager_centers` 연결, owner role 연결
- 카카오·애플 `signInWithOAuth` 호출
- 로그아웃
- Supabase JS가 관리하는 Auth session

## 3. Blocked / Unverified

- 카카오·애플 로그인 성공은 운영 Supabase Provider와 redirect 설정에 의존한다.
- 네이버는 완성된 Provider 흐름으로 확인되지 않는다.
- Auth email template, password policy, session TTL은 Dashboard 설정 확인이 필요하다.
- 저장소 SQL이 운영 Auth/RLS와 일치하는지 별도 확인이 필요하다.

## 4. Not Current State

- 자체 Access/Refresh Token 발급·회전
- `sessions`, `devices`, token family/reuse detection 테이블
- 앱 내 기기 목록/원격 로그아웃
- 비밀번호 찾기/재설정 화면
- 검증된 Account Linking/Unlinking UX
- MFA/passkey
- 이메일 초대 토큰 기반 staff 가입

## 5. Target State

- Supabase password recovery 기반 앱 UX
- social provider의 subject/email 충돌을 안전하게 처리하는 Account Linking
- 마지막 로그인 수단 보호
- 필요 시 MFA/passkey와 session revocation UX
- 인증 후 `accounts`/`profiles` bootstrap을 원자적·재시도 안전하게 개선
- staff 초대가 승인되면 검증된 이메일과 기존 Account 연결

자체 token service는 목표가 아니다. Supabase Auth의 기능으로 충족되지 않는 요구가 확인될 때만 ADR로 검토한다.

## 6. Gap and Risks

- 가입 흐름이 Auth 가입 후 여러 Client-side insert를 수행하므로 부분 실패 복구가 필요하다.
- social login 후 `accounts/profiles` bootstrap 및 기존 이메일 충돌 흐름이 명확하지 않다.
- 매니저 센터 생성도 여러 client mutation에 걸쳐 있어 원자성 Gap이 있다.
- 인증 UI와 DB bootstrap의 중복/재시도 규칙이 부족하다.

## 7. Acceptance Criteria for Future Work

- Auth User와 Account가 중복 생성되지 않는다.
- Profile/manager center bootstrap은 재시도해도 안전하다.
- 이메일 일치만으로 기존 Account를 자동 병합하지 않는다.
- password recovery와 linking은 토큰·오류·계정 존재 정보를 과도하게 노출하지 않는다.
- 인증 성공 후에도 Center permission은 RLS/RPC에서 별도 검증한다.

## 8. Decision Required

- 지원 OAuth Provider와 출시 우선순위
- social Account 자동 생성/연결/충돌 정책
- password reset 후 session 처리
- MFA/passkey 및 기기 관리 범위
- staff 이메일 초대 도입 여부

