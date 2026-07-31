# EPIC 03 — Authentication

## 1. 목표

사용자는 이메일/비밀번호 또는 승인된 소셜 공급자로 안전하게 가입·로그인하고, 로그인 수단을 한 계정에 연결하며, 비밀번호와 세션/기기를 스스로 복구·관리할 수 있다.

## 2. 범위

- 이메일 가입, 이메일 인증, 로그인/로그아웃
- 소셜 로그인(OAuth/OIDC)
- Account Linking/Unlinking과 충돌 처리
- 비밀번호 찾기/재설정/변경
- Access/Refresh Token, 회전, 재사용 탐지
- 세션 및 기기 조회/개별·전체 철회
- 정지 계정, 보안 알림, 인증 감사 이벤트

## 3. 사용자 스토리와 수용 기준

### AUTH-01 이메일 가입과 인증

- 사용자는 이메일, 비밀번호, 필수 약관 동의로 가입한다.
- 비밀번호는 정책에 맞게 검증하고 안전한 KDF로 저장한다.
- 이메일 인증 전 허용 기능을 최소화한다.
- 인증 토큰은 만료·1회 사용하며 재전송 시 rate limit을 적용한다.
- 가입/인증은 계정 존재 여부를 불필요하게 노출하지 않는다.

### AUTH-02 이메일 로그인

- 유효한 활성 계정에 Access/Refresh 세션을 생성한다.
- 실패 응답은 잘못된 이메일/비밀번호/정지 상태를 공격자에게 세분하지 않는다.
- IP+계정 기반 rate limit과 감사 이벤트를 적용한다.
- 성공 시 새 기기/위험 로그인 알림 정책을 실행한다.

### AUTH-03 소셜 로그인

- Authorization Code + PKCE, state, nonce, issuer/audience 검증을 사용한다.
- 기존 `(provider, subject)`면 연결된 User로 로그인한다.
- 신규 identity이고 충돌이 없으면 정책에 따라 User 생성/동의/프로필 완료로 이동한다.
- 기존 이메일과 충돌하면 자동 병합하지 않고 Account Linking 흐름으로 이동한다.
- 공급자 오류·거부·callback 재실행에서 안전하고 이해 가능한 결과를 준다.

### AUTH-04 Account Linking

- 로그인 사용자가 최근 인증을 거쳐 새 공급자 연결을 시작한다.
- 공급자 재인증 후 subject가 다른 사용자에 연결되지 않았는지 원자적으로 확인한다.
- 충돌 로그인 흐름에서는 기존 계정 인증 후 세션에 결박된 단기 linking ticket을 사용한다.
- 연결 성공/실패/해제를 감사하고 사용자에게 알린다.
- 최소 하나의 사용 가능한 로그인 수단을 항상 남긴다.

### AUTH-05 비밀번호 찾기와 재설정

- 사용자는 이메일로 재설정 링크를 요청한다.
- 계정 존재 여부와 관계없이 같은 응답을 받는다.
- 토큰은 짧은 만료, 해시 저장, 1회 사용이며 새 요청 시 이전 토큰 무효화 정책을 적용한다.
- 새 비밀번호는 이전과 동일한 정책을 적용하고 성공 시 기존 세션을 철회한다.
- 성공/의심 활동을 사용자에게 통지한다.

### AUTH-06 세션 갱신과 로그아웃

- 짧은 Access Token 만료 전/후 유효한 Refresh Token으로 갱신한다.
- 갱신할 때 Refresh Token을 회전하고 이전 토큰을 폐기한다.
- 폐기된 토큰 재사용을 감지하면 token family 전체를 철회한다.
- 로그아웃은 현재 세션, 전체 로그아웃은 선택된 범위의 세션을 철회한다.
- 철회는 허용된 최대 지연 안에 모든 API에서 반영된다.

### AUTH-07 기기 관리

- 사용자는 현재/다른 기기, 플랫폼, 최근 활동, 대략적 위치를 본다.
- 개별 기기/세션 및 “다른 모든 기기”를 철회할 수 있다.
- 현재 세션 철회 시 즉시 로그인으로 이동한다.
- 낯선 기기 신고 시 철회, 비밀번호 변경, 소셜 계정 점검을 안내한다.
- IP와 User-Agent는 표시/보존을 최소화하고 정확성을 보장하지 않는다고 알린다.

### AUTH-08 계정 상태와 복구

- suspended/deleted 사용자는 새 로그인과 refresh를 할 수 없다.
- 정지 시 활성 세션을 철회한다.
- 계정 삭제 전 최근 재인증과 영향 안내를 요구한다.
- 인증 수단을 잃은 계정의 수동 복구는 v1에서 고객지원 검증 절차가 확정된 경우에만 제공한다.

## 4. 보안 불변조건

1. 토큰 원문과 비밀번호는 로그/DB에 저장하지 않는다.
2. 이메일 동일성만으로 User를 병합하지 않는다.
3. 한 provider subject는 정확히 한 User에만 연결된다.
4. 마지막 로그인 수단은 제거하지 않는다.
5. reset/link/verify/invite 토큰은 목적·사용자·만료·1회 사용에 제한된다.
6. Refresh Token 재사용은 조용히 허용하지 않는다.
7. 인증 후에도 센터 접근은 별도 권한 검사를 통과해야 한다.

## 5. 오류 코드

- `AUTH_INVALID_CREDENTIALS`
- `AUTH_EMAIL_VERIFICATION_REQUIRED`
- `AUTH_ACCOUNT_UNAVAILABLE`
- `AUTH_RATE_LIMITED`
- `OAUTH_STATE_INVALID`
- `OAUTH_PROVIDER_ERROR`
- `ACCOUNT_LINK_REQUIRED`
- `ACCOUNT_ALREADY_LINKED`
- `LAST_LOGIN_METHOD_REQUIRED`
- `TOKEN_INVALID_OR_EXPIRED`
- `SESSION_REVOKED`
- `REFRESH_TOKEN_REUSE_DETECTED`

내부 원인을 과도하게 노출하지 않되 UI가 올바른 복구 경로를 제시할 만큼 안정적인 코드를 사용한다.

## 6. 완료 기준

- 이메일/소셜/연결/재설정/세션/기기 E2E 통과
- OAuth 변조, 토큰 replay, enumeration, CSRF, rate limit 테스트 통과
- 연결/해제/재설정/철회의 감사 및 알림 확인
- 공급자별 staging sandbox 검증
- 장애 시 소셜 로그인 비활성화 및 세션 전체 철회 runbook 준비
- [Security](../05_Security.md) 출시 게이트 승인

## 7. 제외

MFA/passkey, 엔터프라이즈 SSO, SCIM, 전화번호 로그인은 v1 후속 후보이며 도입 시 Account Linking과 복구 정책을 다시 위협 모델링한다.

