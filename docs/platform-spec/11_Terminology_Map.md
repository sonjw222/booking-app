# Terminology Map

Status: Active Canonical Vocabulary
Version: 1.1.0
Current-State Source: `schema.sql`, incremental SQL, `lib/**`, `app/**`
Target-State Status: Use official terms in new code and documentation
Last Updated: 2026-07-31

## 1. Canonical Mapping

| 명세 용어 | 실제 코드 용어 | 의미 | 현재 사용 위치 | 앞으로 사용할 공식 용어 | 변경 필요 여부 |
|---|---|---|---|---|---|
| User | `auth.users` | Supabase 인증 주체 | Supabase Auth, `auth.getUser()` | Auth User | 문서 교정 |
| User/Application User | `accounts` | 로그인 사용자와 앱 권한 단위 | `lib/*`의 auth→account 조회 | Account | 문서 교정 |
| Customer/Student | `profiles` | 실제 예약·수강 주체, 한 Account에 복수 | 예약, 수강권, 주문, 진도 | Profile / 수강 프로필 | 문서 교정 |
| Center/Tenant | `centers` | 센터 운영·데이터 범위 | 전 영역 | Center | 유지 |
| Organization Membership | `manager_centers` | Account의 센터 운영 소속 | `/manager`, `lib/manager.ts`, `lib/roles.ts` | Center Staff Assignment | 변경 필수 |
| Membership | `memberships` | 회원이 보유한 수강권/패스 | 예약, 마이페이지, 발급 | Membership Pass / 수강권 | 변경 필수 |
| Role | `center_roles` | 센터 시스템·커스텀 역할 | 스태프/권한 관리 | Center Role | 구체화 |
| Permission | `permissions` | 권한 키 카탈로그 | `lib/roles.ts`, RLS/RPC | Permission | 유지 |
| Role Permission | `role_permissions` | 역할별 권한 | 권한 설정 | Role Permission | 유지 |
| Personal Permission | `account_center_permissions` | staff assignment별 allow/deny | 개인 권한 설정 | Personal Permission Override | 구체화 |
| Service | `classes` | 예약 가능한 실제 수업 스케줄 | 예약 캘린더, 수업 관리 | Class | 변경 필수 |
| Service Type | `class_types` | 센터별 수업 구분 | 스키마/설정 | Class Type | 변경 |
| Booking | `reservations` | Profile의 Class 예약/대기/출석 | `lib/reservations.ts`, RPC | Reservation | 변경 필수 |
| Staff | `manager_centers` + `accounts` | 센터 운영자/강사 | `/manager/staff` | Center Staff | 구체화 |
| Customer record | `center_members` + `profiles` | 센터 회원 상태와 수강 주체 | 회원 관리 | Center Member + Profile | 변경 필수 |
| Product/Service product | `products` | pass 또는 goods 판매 항목 | 상품, 장바구니, 주문 | Product | 유지 |
| Issued pass | `memberships` | pass 상품의 발급 인스턴스 | 주문 처리, 예약 차감 | Membership Pass / 수강권 | 명확화 |
| Goods pass | `product_passes` | goods 보유/사용권 | 상품 사용 | Product Pass | 제품명 결정 필요 |
| Order | `orders` | 구매 요청·결제/처리 상태 | checkout, purchases, manager orders | Order | 유지 |
| Payment | `payments` | 센터 매출/결제 기록 | 매출 관리 | Payment Record | 구체화 |
| Mock Payment | `lib/payments/MockPaymentProvider.ts` | 테스트 결제 흐름 | checkout, test RPC | Mock Payment | 운영 결제와 구분 |
| Admin booking | `ADMIN_ASSIGNMENT` | 수강권을 사용한 관리자 직접배치 | classes UI, RPC, audit | 관리자 직접배치 | 유지 |
| Free booking | `ADMIN_FREE` | 수강권 차감 없는 무료 추가 배치 | classes UI, RPC, audit | 무료 추가 배치 | 유지 |
| Platform Admin | `accounts.is_platform_admin` | 서비스 운영자 | `/admin`, RLS | Platform Admin | 유지 |
| Session | Supabase Auth session | SDK가 관리하는 로그인 상태 | Supabase client | Supabase Auth Session | 자체 테이블 표현 제거 |
| Device | 구현 없음 | 기기별 로그인 관리 목표 | 없음 | Device Session (Future) | Decision Required |
| API | Supabase table/RPC calls | 현재 앱 데이터 접근 계약 | `lib/*.ts` | Supabase Data Access/RPC | REST 표현 교정 |

## 2. State/Gap Matrix

| Area | Current State | Target State | Gap | Priority | Decision Required |
|---|---|---|---|---|---|
| Stack | Next 16.2.10, React 19, TS, Supabase | 유지·타입/구조 강화 | generated DB types 부족 | P1 | migration/type 도구 |
| Data access | Client→lib→Supabase | 필요한 신뢰 경계만 서버화 | 외부 secret 처리 계층 없음 | P0 for real PG | Route Handler vs Edge Function |
| Auth | Supabase email/password/OAuth 호출 | recovery/linking/MFA 검토 | linking/recovery/device UX 없음 | P1 | Auth 범위 |
| Session | Supabase 관리형 | 사용자 보안 UX | 앱 기기 관리 없음 | P2 | 필요 여부 |
| Multi-center | centers + manager_centers + RLS | 완전한 UI/RLS 일관성 | 일부 UI guard 불균일 | P1 | guard 정책 |
| Roles | custom roles + permissions + overrides | UI와 DB 판정 일치 | UI 선반영 부족 | P1 | 숨김/disabled |
| Reservation | classes/reservations + RPC | 동시성·정책 테스트 강화 | 누적 SQL 적용 상태 | P0 | 운영 migration 확인 |
| Admin assignment | 직접배치/무료배치 + logs | 세부 permission/상태 정책 | 제품 정책 일부 미확정 | P0/P1 | permission와 차단 규칙 |
| Commerce | products/memberships/orders/payments | 실제 PG | Mock만 구현 | P0 for launch | PG 공급자 |
| Notification | DB/Reatime 알림 | push/알림톡/스케줄 | 외부 발송·scheduler 없음 | P1 | 공급자/채널 |
| Audit | admin assignment logs 등 부분 구현 | 통합 감사 체계 | 이벤트 범위·보존 불명확 | P1 | 보존 기간 |
| Timezone | KST 고정 로직 일부 | 센터별 IANA timezone | 모델/표시 불일치 가능 | P2 | 국내 전용 여부 |

## 3. Usage Rule

새 문서와 코드는 “예약=Reservation”, “수업=Class”, “수강권=Membership Pass”, “운영 소속=Center Staff Assignment”을 사용한다. UI의 자연어는 사용자 친화적으로 번역할 수 있지만 DB 의미가 바뀌지 않게 한다.

