# Data Access and API

Status: Active Current-State Contract
Version: 1.1.0
Current-State Source: `lib/*.ts`, `lib/payments/**`, `app/**`, repository RPC SQL
Target-State Status: Route Handler/Edge Function only where justified
Last Updated: 2026-07-31

## 1. Current State

현재 앱의 애플리케이션 API는 자체 REST `/api/v1`이 아니다. Client Component가 `lib/*.ts` 함수를 호출하고, 이 함수가 Supabase JS로 PostgREST 테이블/view, RPC, Storage, Realtime에 직접 접근한다.

```text
Page/Component → lib domain function → supabase.from()/rpc()/storage/channel()
                                      → RLS/RPC authorization
```

- `app/api/**/route.ts`: 없음
- Server Action (`"use server"`): 없음
- 자체 JSON 오류 envelope, cursor pagination, Bearer API 계약: 없음
- Supabase SDK의 `{ data, error }`와 `lib` 함수의 Error 메시지가 현재 호출 계약이다.

## 2. Current Client Data Modules

| Module | Main responsibility |
|---|---|
| `lib/reservations.ts` | 월간 수업, 프로필, 수강권, 예약/취소 |
| `lib/adminAssignment.ts` | 직접배치·무료배치·취소·작업 로그 |
| `lib/classes.ts` | 센터 수업, 반복 등록, 회원 배치 |
| `lib/orders.ts`, `lib/payments/**` | 주문, 발급, Mock 결제 |
| `lib/roles.ts` | 커스텀 역할, 역할 permission, 개인 예외 |
| `lib/manager.ts`, `lib/admin.ts` | 센터 운영/플랫폼 운영 |
| `lib/members.ts`, `profiles.ts`, `passes.ts` | 회원·프로필·수강권 |
| `lib/notifications.ts`, `inquiries.ts` | Realtime 알림·문의 |

## 3. Current Mutation Rules

### Direct table mutations

단순 CRUD는 `.from(table).insert/update/delete`로 수행하고 RLS가 최종 허용 여부를 결정한다. 예: 프로필, 센터 설정, 역할, 상품, 주문의 일부 관리 작업.

### RPC mutations

정합성과 여러 테이블의 원자적 변경이 필요한 작업은 RPC를 사용한다.

- 회원 예약/취소 및 수강권 차감·복원
- 관리자 직접배치/무료배치와 취소
- 출석, 자동예약, 주문 발급
- Mock 결제 확인/취소
- 포인트, 환불, 문의, 알림 처리

클라이언트의 사전 검사나 표시값은 보안·정합성 근거가 아니다.

## 4. Current Error and Idempotency

- 오류는 Supabase error 또는 `lib`에서 변환한 한국어 `Error`로 전달된다.
- 안정적인 전역 error code envelope는 없다.
- 일부 RPC는 중복 상태를 확인하지만 모든 쓰기 흐름에 공통 `Idempotency-Key` 계약이 있는 것은 아니다.
- Mock 결제 RPC는 이미 완료된 주문을 구분하는 결과를 제공한다.

## 5. Gap

- UI가 DB 오류 문자열에 의존하는 부분이 있어 안정적인 도메인 오류 분류가 부족하다.
- 목록 pagination이 일관된 공통 계약으로 적용되지 않는다.
- 실제 PG secret 및 webhook을 안전하게 처리할 서버 엔드포인트가 없다.
- Supabase Database 타입 생성과 RPC 입출력 타입 자동화가 없다.
- 외부 클라이언트용 공개 API 계약은 정의되지 않았다.

## 6. Target/Future State

다음 경우에만 Route Handler 또는 Supabase Edge Function을 도입한다.

- PG 승인·취소·webhook과 서버 전용 secret
- 이메일/알림 공급자 secret 및 서명 검증
- 관리자 전용 고위험 작업에 추가 감사·rate limit이 필요한 경우
- 여러 외부 시스템을 조합하는 backend orchestration

단순한 앱 CRUD를 REST로 중복 포장하는 것은 기본 목표가 아니다. RLS/RPC를 유지하면서 필요한 신뢰 경계만 추가한다.

향후 공통화 후보:

- 도메인 error code와 사용자 메시지 분리
- pagination/filter/sort 계약
- 결제 webhook idempotency
- RPC TypeScript 타입 생성
- 외부 API가 생길 때만 버전 관리와 인증 계약

## 7. Not Current State

v1.0의 `/api/v1/auth/*`, `/centers/{centerId}/*`, 자체 Refresh Token endpoint, `Idempotency-Key` 전역 규칙은 현재 구현이 아니다. 해당 개념은 필요한 경우 Target State의 별도 ADR로 승인한다.

## 8. Decision Required

- Route Handler와 Edge Function의 배치 기준
- 실제 PG 공급자와 webhook 계약
- 사용자 표시 오류와 내부 오류 코드 체계
- public/partner API 제공 여부

