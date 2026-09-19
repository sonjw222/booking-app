# Booking App Master Spec v1.1 — Project Principles

Status: Active Baseline
Version: 1.1.0
Current-State Source: `package.json`, `app/**`, `lib/**`, repository SQL, tests
Target-State Status: Directional; not implemented unless explicitly marked Current State
Last Updated: 2026-07-31

## 1. Purpose

Booking App은 여러 센터의 회원 예약·수강권·상품·운영을 하나의 앱에서 제공한다. 이 문서 세트는 실제 코드의 현재 상태와 장기 목표를 구분하는 기준 사양이다.

규칙:

- **Current State**는 저장소 코드에서 확인한 구현이다.
- **Target State/Future State**는 앞으로의 목표이며 현재 구현으로 간주하지 않는다.
- **Gap**은 현재와 목표의 차이다.
- **Decision Required**는 제품 소유자의 결정 없이는 확정할 수 없다.
- **Blocked**는 외부 공급자, 운영 Supabase 설정, 법률·사업 정책 등 저장소 밖 조건이 필요하다.

## 2. Current State

현재 앱은 Next.js 16.2.10 App Router, React 19.2.4, TypeScript 5, Supabase JS 2.x로 구현되어 있다. Supabase Auth, Postgres, RLS, RPC, Storage, Realtime을 사용한다.

- 브라우저 Client Component가 `lib/*.ts`를 통해 Supabase 테이블과 RPC를 직접 호출한다.
- `app/api/**/route.ts` Route Handler와 Server Action은 없다.
- 하나의 Next.js 앱에 회원 기능과 `/manager/*` 센터 운영 기능, `/admin/*` 플랫폼 운영 기능이 공존한다.
- 다중 센터는 `centers`, `manager_centers`, 센터별 수강권과 운영 데이터로 구현된다.
- 로그인 단위는 `accounts`, 실제 수강 주체는 복수의 `profiles`다.
- 조직 역할 관계는 `manager_centers`, `center_roles`, `role_permissions`, `account_center_permissions`다.
- `memberships`는 조직 Membership이 아니라 회원이 보유한 **수강권/패스**다.
- 수업은 `classes`, 예약은 `reservations`, 판매 항목은 `products`, 주문은 `orders`다.
- 관리자 직접배치와 무료 추가 배치는 `ADMIN_ASSIGNMENT`, `ADMIN_FREE` 예약 유형 및 RPC로 구현된다.
- Payment Adapter와 Mock 결제는 구현됐고 실제 Toss/PortOne Provider는 골격만 있다.

## 3. Product Principles

1. **코드가 Current State의 기준이다.** 문서는 코드에 없는 기능을 구현 완료로 표현하지 않는다.
2. **RLS/RPC가 최종 보안 경계다.** UI 가드는 사용자 경험이며 권한 통제의 대체물이 아니다.
3. **센터 범위를 모든 계층에서 유지한다.** 쿼리, RPC, Storage, Realtime, UI 선택 상태가 다른 센터 데이터를 섞지 않아야 한다.
4. **계정과 수강 주체를 구분한다.** `accounts` 하나가 여러 `profiles`를 관리할 수 있다.
5. **운영 소속과 수강권을 구분한다.** `manager_centers`는 운영 관계, `memberships`는 수강권이다.
6. **예약 정합성은 RPC/DB에서 보장한다.** 정원, 수강권, 중복, 대기, 차감은 브라우저 사전 검사만 믿지 않는다.
7. **회원과 운영자가 같은 앱을 안전하게 공유한다.** 모드가 달라도 계정과 센터 경계를 일관되게 적용한다.
8. **주문과 실제 결제를 혼동하지 않는다.** Mock 결제 성공과 운영 PG 승인은 다른 상태다.
9. **권한은 고정 역할명이 아니라 카탈로그와 예외를 포함해 판정한다.**
10. **미완성 기능은 제한과 다음 행동을 명시한다.**

## 4. Current Product Scope

### Implemented or partially implemented

- 이메일/비밀번호 가입·로그인, Supabase OAuth 호출
- 복수 프로필과 회원/매니저 모드
- 센터 등록·승인, 다중 센터 운영
- 수업, 룸, 휴무, 설정, 예약·취소·대기·출석·노쇼
- 수강권, 예약 조건, 공유 수강권, 자동예약
- 관리자 직접배치·무료배치·작업 로그
- 상품, 장바구니, 주문, 수강권 발급, Mock 결제
- 회원·진도·매출·공지·알림·문의·후기 관리
- 커스텀 센터 역할, 역할별 권한, 개인별 allow/deny

### Blocked or partial

- 카카오·애플 OAuth는 Supabase Provider/redirect 운영 설정이 필요하다.
- 네이버 로그인은 완성된 Provider 흐름이 아니다.
- 실제 PG는 미연동이다.
- 외부 푸시·알림톡과 예약/만료 알림 스케줄러는 운영 연동이 필요하다.
- 저장소 SQL이 운영 Supabase에 모두 적용됐는지는 저장소만으로 확정할 수 없다.

## 5. Target State

다음은 기존 v1.0의 원칙을 보존한 목표다.

- 안전한 Account Linking, 비밀번호 복구 UX, 세션·기기 관리
- 운영 PG와 서명된 webhook
- 세부 권한을 반영한 선제적 UI 가드
- 일관된 감사 로그와 보안 이벤트
- Route Handler/Edge Function 등 신뢰 서버 경계가 필요한 외부 연동
- 운영 환경 관측, 백업·복구, 개인정보 보존·삭제 정책

이 항목들은 현재 구현으로 간주하지 않는다.

## 6. Decision Required

- 실제 PG: Toss, PortOne 또는 다른 공급자
- OAuth 공급자 우선순위와 Account Linking 정책
- 비밀번호 복구, MFA/passkey, 세션·기기 UX 범위
- 관리자 직접배치/무료배치 세부 permission key와 회원 상태 차단 정책
- 센터별 시간대 일반화 여부(현재 예약 표시 로직 일부는 `Asia/Seoul` 고정)
- 감사/개인정보 보존 기간

## 7. Definition of Done

- 코드, SQL, RLS/RPC와 문서의 Current State가 일치한다.
- 센터 교차 접근, 권한 거부, 예약 동시성의 부정 테스트가 있다.
- 운영 외부 조건은 Blocked로 표시하고 설정 증거 없이 완료 처리하지 않는다.
- UI·DB·RPC·테스트·문서가 함께 갱신된다.
- 배포 및 롤백/forward-fix 계획이 있다.

## 8. Document Conflict Rule

보안·법적 요구 → 실제 코드/적용된 DB → 본 원칙 → 하위 사양 순이다. 저장소 SQL은 설계 증거이나 운영 적용 상태의 증거는 아니다. 충돌은 [Decision Log](./08_Decision_Log.md)에 기록하고 용어는 [Terminology Map](./11_Terminology_Map.md)을 따른다.

