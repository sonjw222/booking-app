# Security

Status: Active Security Baseline
Version: 1.1.0
Current-State Source: Supabase Auth calls, repository RLS/RPC SQL, `lib/**`, Storage/Realtime usage
Target-State Status: Additional controls require implementation/operations
Last Updated: 2026-07-31

## 1. Current Trust Model

- 인증 세션은 Supabase Auth와 Supabase JS SDK가 관리한다.
- 브라우저는 공개 anon key를 사용한다. service-role key를 클라이언트에 포함하면 안 된다.
- 데이터 접근 통제의 최종 경계는 Postgres RLS와 RPC 내부 권한 검증이다.
- 앱의 `accounts.auth_id`가 Auth user와 연결된다.
- 센터 운영 권한은 `manager_centers`, `center_roles`, permission tables와 `has_permission()`으로 판정한다.

## 2. Current Authentication

- 이메일/비밀번호 `signUp`, `signInWithPassword`, `signOut`
- Supabase `signInWithOAuth`를 통한 카카오·애플 호출
- Provider와 redirect 설정은 운영 Supabase 외부 조건이다.
- 자체 비밀번호 해시, Access/Refresh Token 발급, token family, `sessions/devices` 저장소는 없다.
- Supabase Auth의 실제 세션 정책·비밀번호 정책·메일 템플릿은 Dashboard 설정 확인 없이는 단정할 수 없다.

## 3. Current Authorization

- Platform Admin: `accounts.is_platform_admin`
- Center staff assignment: `manager_centers`
- Roles: 시스템 owner/manager/trainer + 센터별 커스텀 역할
- Permissions: `permissions`, `role_permissions`
- Personal overrides: `account_center_permissions`의 allow/deny
- Owner는 전권이며 개인 deny/role 해석 순서는 SQL의 `has_permission()`을 기준으로 한다.

관리 화면 노출 여부가 권한 증거가 되어서는 안 된다. 모든 쓰기와 민감 조회는 RLS 또는 permission-aware RPC가 거부해야 한다.

## 4. Current High-Risk Operations

- 예약/수강권 차감, 취소/복원, 대기 승격
- 관리자 직접배치·무료배치·정원 초과
- 주문 발급, Mock 결제 확인/취소, 환불
- 센터 승인/반려와 플랫폼 운영
- 역할, 권한, 개인 예외 변경
- Storage 업로드와 Realtime subscription

이 작업들은 Auth user와 대상 Center/Profile/Account 관계를 DB에서 재확인해야 한다. `center_id`, `profile_id`, `account_id`, assignment type을 클라이언트 값만으로 신뢰하지 않는다.

## 5. Gaps

- Account Linking과 social identity 충돌 정책이 앱 수준에서 구현/문서화되지 않았다.
- 비밀번호 찾기/재설정 UI를 코드에서 확인하지 못했다.
- 기기 목록, 개별 세션 철회, Refresh 재사용 탐지는 앱 자체 기능이 아니다.
- 일부 관리 UI guard가 불균일하다.
- 운영 SQL/RLS 적용 상태, Auth Provider 설정, Realtime publication을 저장소만으로 확인할 수 없다.
- 실제 PG webhook과 server-only secret 경계가 없다.
- 누적 SQL 함수의 `SECURITY DEFINER`, `search_path`, execute grant를 전체적으로 감사해야 한다.

## 6. Target State

- Supabase Auth 기반 비밀번호 복구와 안전한 social Account Linking
- 위험 작업의 recent re-auth/MFA 검토
- 실제 PG를 위한 Route Handler/Edge Function, 서명 검증, idempotency
- permission-aware UI와 서버 enforcement의 이중 방어
- 보안 이벤트·감사 로그 기준 통합
- 생성된 DB 타입과 RLS/RPC 회귀 테스트
- 개인정보 보존·삭제·마스킹 정책

자체 Refresh Token 시스템은 기본 목표가 아니다. Supabase Auth를 유지하면서 제품 요구를 충족하지 못하는 구체적 Gap이 있을 때만 별도 ADR로 검토한다.

## 7. Required Security Tests

- A센터 운영자가 B센터의 class/reservation/member/order/role을 조회·변경하지 못함
- Profile 소유자가 아닌 Account의 예약·수강권 접근 차단
- custom role, personal allow/deny, owner 우선순위
- 직접배치 permission·센터·회원 상태·정원 override
- RPC 파라미터 변조와 반복 호출
- Storage object 경로 및 Realtime row 노출
- Platform Admin API-equivalent 작업의 일반 사용자 차단
- Mock 결제 RPC의 타인 주문·금액 변조·중복 확인 차단

## 8. Decision Required / Blocked

| Type | Item |
|---|---|
| Decision Required | OAuth 계정 자동 생성 및 Account Linking 정책 |
| Decision Required | 비밀번호 복구, MFA/passkey, 기기 관리 범위 |
| Decision Required | 직접배치/무료배치 permission와 정지·탈퇴 회원 정책 |
| Decision Required | 감사 로그/PII 보존 기간 |
| Blocked | Supabase Auth/Provider/redirect 운영 설정 |
| Blocked | 운영 DB migration, RLS, Realtime, Storage policy 적용 증거 |

