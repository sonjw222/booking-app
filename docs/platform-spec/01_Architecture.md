# Architecture

Status: Active, Current/Target Split
Version: 1.1.0
Current-State Source: `package.json`, `app/**`, `lib/supabaseClient.ts`, `lib/**`, repository SQL
Target-State Status: Future State is non-binding until approved
Last Updated: 2026-07-31

## 1. Current Architecture

```text
Browser
  └─ Next.js App Router Client Components
       ├─ Member routes
       ├─ /manager/* Staff/Admin routes
       └─ /admin/* Platform Admin routes
            │
            └─ lib/*.ts
                 └─ @supabase/supabase-js
                      ├─ Supabase Auth
                      ├─ PostgREST tables/views + RLS
                      ├─ Postgres RPC
                      ├─ Storage
                      └─ Realtime
```

### Confirmed stack

| Area | Current State |
|---|---|
| Web | Next.js 16.2.10 App Router |
| UI | React 19.2.4, Client Components 중심 |
| Language | TypeScript 5 |
| Backend/BaaS | Supabase JS 2.110.x |
| Authentication | Supabase Auth |
| Database | Supabase Postgres |
| Authorization | RLS, security-aware RPC, permission functions |
| Data access | Client → `lib/*.ts` → Supabase direct |
| Server endpoints | `app/api` Route Handler 없음 |
| Server mutations | Server Action 없음 |
| Async/live | Supabase Realtime, DB triggers/functions 일부 |
| Files | Supabase Storage |

## 2. Application Boundaries

하나의 앱에서 세 영역이 공존한다.

- **Member:** 홈, 센터, 예약, 장바구니/결제, 구매, 마이페이지, 프로필, 알림, 문의
- **Center Operations:** `/manager/*`에서 센터, 수업, 회원, 주문, 매출, 역할/권한, 직접배치 관리
- **Platform Operations:** `/admin/*`에서 입점 센터 승인, 카테고리, 배너 관리

현재 프론트엔드는 별도 BFF/API 계층 없이 Supabase를 호출한다. 보안은 브라우저의 화면 조건이 아니라 RLS와 RPC에서 최종 강제되어야 한다.

## 3. Current Domain Flow

- Supabase Auth user ID는 `accounts.auth_id`에 연결된다.
- `accounts`는 로그인·플랫폼 권한 단위다.
- `profiles`는 예약·수강권·진도·주문의 수강 주체다.
- `manager_centers`는 계정과 센터의 운영 소속이며 `center_roles`에 연결된다.
- `center_roles` + `role_permissions` + `account_center_permissions` + `has_permission()`이 센터 권한을 구성한다.
- `classes`에 `reservations`가 연결되고 예약/취소/직접배치는 RPC가 원자적으로 처리한다.
- `products` 구매는 `orders`를 만들고, Mock Provider는 테스트 RPC로 결제 상태와 수강권 발급을 처리한다.

## 4. Current Security and Consistency Boundary

| Concern | Current mechanism |
|---|---|
| Auth session | Supabase Auth SDK 관리형 세션 |
| Center access | RLS, `manager_centers`, RPC permission check |
| Custom permission | `has_permission(center_id, permission_key)` |
| Reservation consistency | `reserve_*`, `cancel_reservation`, `admin_assign_reservation` RPC와 DB 제약 |
| Realtime access | Realtime publication + 해당 테이블 RLS에 의존 |
| Storage access | 버킷 정책과 경로 정책에 의존 |

## 5. Gap

- 일부 `/manager`·`/admin` 화면은 사전 UI 가드가 일관되지 않다.
- Supabase 클라이언트 타입이 생성 스키마 타입으로 강제되지 않고 `any` 사용이 많다.
- SQL 파일이 누적되어 단일 migration 이력과 운영 적용 상태를 저장소만으로 확인하기 어렵다.
- 외부 PG secret, webhook, 관리자 수준 작업처럼 브라우저에 둘 수 없는 기능을 위한 서버 신뢰 경계가 없다.
- 자체 기기 목록/세션 철회 UI는 없다. Supabase Auth 세션을 사용한다.
- 일부 날짜 표시가 `Asia/Seoul`에 고정되어 센터별 timezone 모델과 연결되지 않는다.

## 6. Target Architecture

기존 v1.0의 모듈 경계·관측·복구 원칙은 목표로 유지하되 현재 구현으로 표현하지 않는다.

- 기능별 `lib` 모듈을 명확한 도메인 서비스 계약으로 정리
- 생성된 Supabase Database 타입과 스키마 migration 체계
- 민감한 외부 연동용 Next.js Route Handler 또는 Supabase Edge Function
- 실제 PG 승인·취소·webhook의 서버 전용 secret 관리
- 일관된 감사 이벤트 및 운영 지표
- 필요할 때만 background job/outbox 또는 Supabase-native queue 도입
- 서버 렌더링/Server Action 도입은 보안·성능 이점이 확인된 흐름부터 점진 적용

## 7. Decision Required

- Next.js Route Handler와 Supabase Edge Function의 책임 분리
- 운영 migration 도구와 기준 스키마
- 결제 webhook 및 idempotency 저장 위치
- 센터별 timezone 지원 범위
- 세션·기기 관리가 제품 요구인지, Supabase 관리 기능으로 충분한지

## 8. Not Current State

다음은 현재 구조가 아니다: 자체 REST BFF, 자체 Access/Refresh Token 발급·회전, `sessions`/`devices` 테이블, 트랜잭셔널 outbox, 마이크로서비스. 필요하면 ADR 승인 후 Target State에서 구현한다.

