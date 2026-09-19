# Testing

Status: Active Test Strategy
Version: 1.1.0
Current-State Source: `package.json`, `vitest*.config.ts`, `tests/**`, implementation and SQL
Target-State Status: Coverage expansion required
Last Updated: 2026-07-31

## 1. Current Tooling

- Unit: Vitest (`npm test`)
- Integration: Vitest integration config (`npm run test:integration`)
- Combined: `npm run test:all`
- Build/static: Next build, ESLint, TypeScript through project toolchain

통합 테스트는 Supabase 환경·권한 fixture에 의존한다. 저장소 테스트 통과와 운영 Supabase 설정 완료는 별개다.

## 2. Current-State Test Model

테스트 대상은 REST endpoint가 아니라 다음 계층이다.

- `lib/*.ts` 도메인 함수와 UI utility
- Supabase table/view query 계약
- Postgres RPC 결과와 RLS 거부
- Next.js 페이지의 주요 사용자 흐름
- Payment Provider/Service의 Mock scenario

## 3. Mandatory Regression Matrix

### Account/Profile

- Auth user가 자신의 `accounts`만 연결
- 한 Account의 복수 Profile 조회·예약
- 다른 Account Profile 접근 차단

### Multi-center authorization

- A센터 staff가 B센터의 운영 데이터 접근 실패
- owner/system/custom role 및 personal allow/deny 조합
- Platform Admin과 Center staff 권한 분리
- UI guard가 없어도 RLS/RPC가 차단

### Reservations

- `reserve_class`, 수강권 지정 예약, goods 동시 예약
- 정원 도달 시 waitlisted, 취소 시 승격
- 활성 중복 예약 방지
- 수강권 잔여 횟수 음수 방지·취소 복원
- 예약 조건, 공유 수강권, 자동예약과 미배치
- 출석·노쇼 상태 전이

### Admin assignment

- `ADMIN_ASSIGNMENT`는 유효한 수강권/미배치 조건에 맞게 차감
- `ADMIN_FREE`는 수강권을 차감하지 않음
- 정원 초과는 확인/permission 없이 우회 불가
- 생성/취소가 `admin_action_logs`에 기록
- 회원 화면은 내부 무료/사유 정보를 노출하지 않음

### Products/orders/payments

- pass/goods 상품과 장바구니/주문
- Mock success/failed/cancelled
- 성공 RPC 중복 호출의 안전성
- 타인 주문 확인/취소/발급 차단
- 실제 PG Provider는 미구현임을 테스트/표시

### Auth/Realtime/Storage

- 이메일 로그인·회원가입 실패/성공
- OAuth 설정 부재 시 안전한 실패
- Realtime subscription이 RLS 범위를 넘지 않음
- Storage bucket/path 정책

## 4. Gap

- 브라우저 E2E와 접근성 자동화의 기준이 Master Spec에 연결되어 있지 않다.
- 운영 스키마 migration 적용을 재현하는 단일 CI 흐름이 불명확하다.
- SQL/RPC가 누적 파일에 분산되어 fresh DB 검증이 어렵다.
- Account Linking, password recovery, session/device는 구현 전 테스트 대상이 아니다.

## 5. Target State

- fresh Supabase DB migration → seed → RLS/RPC integration test
- A/B center와 Account/Profile/role fixture 표준화
- Playwright 기반 핵심 E2E 및 접근성 검사
- generated Database type drift check
- 결제 webhook replay/idempotency test
- 운영 설정 smoke checklist

## 6. Release Gate

- 코드 변경 범위에 맞는 unit/integration 통과
- 센터 교차 접근과 permission 부정 테스트 통과
- 예약/직접배치/결제 동시성·중복 테스트
- Next build/lint 통과
- Blocked 운영 설정은 담당자·검증 방법·출시 조건 명시

