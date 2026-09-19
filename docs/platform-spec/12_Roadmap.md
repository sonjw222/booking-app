# Technical Roadmap

Status: Active Implementation Sequence
Version: 1.1.0
Current-State Source: Booking App Master Spec v1.1
Target-State Status: Directional; versions are planning bands, not release commitments
Last Updated: 2026-07-31

# 목적

이 문서는 Booking App의 제품 기능 목록이 아니라, [Master Spec v1.1](./00_Project_Principles.md)에 정의된 Current State에서 Target State로 안전하게 이동하기 위한 **기술 구현 로드맵**이다.

Current와 Target 사이에 검증 가능한 Intermediate 단계를 두고, 외부 조건이나 제품 결정이 필요한 항목을 `Blocked By`로 명시한다. 이 문서는 구현 완료를 선언하지 않으며 실제 상태는 코드, SQL, 운영 Supabase 검증 결과와 Master Spec을 따른다.

# 사용 방법

1. 작업 전 Feature의 Current와 `Blocked By`를 확인한다.
2. Target을 직접 구현하지 않고 Intermediate의 가장 작은 검증 단위를 선택한다.
3. 선행 조건이 충족되면 [Implementation Roadmap](./13_Implementation_Roadmap.md)의 Phase 순서에 따라 작업한다.
4. 완료 증거가 코드·테스트·운영 설정에 생긴 뒤에만 Current를 갱신한다.
5. 제품 결정이 필요한 내용은 [Decision Log](./08_Decision_Log.md)에 ADR로 확정한다.
6. Backlog와 충돌하면 Backlog를 수정하지 않고 이 문서에 충돌 이유와 판단 필요 사항을 기록한다.

# Roadmap 원칙

- **Current:** 실제 저장소에서 확인된 구현과 검증 가능한 운영 상태
- **Intermediate:** Target으로 가기 전에 위험을 줄이고 검증 가능하게 만드는 다음 단계
- **Target:** Master Spec이 정의한 승인 대상 미래 상태
- **Priority:** 기술 위험과 선행 관계 기준. `P0`가 가장 높다.
- **Blocked By:** 사용자 결정, 운영 Supabase, 외부 공급자, 법률·사업 정책 등 선행 조건
- **Expected Version:** 계획 구간. `v1.1 Current`, `v1.2 Intermediate`, `v2.x Target`이며 출시 약속이 아니다.

# Technical Roadmap

| Feature | Current | Intermediate | Target | Priority | Blocked By | Expected Version |
|---|---|---|---|---|---|---|
| Authentication | Supabase Auth 이메일/비밀번호 가입·로그인·로그아웃과 카카오·애플 OAuth 호출이 존재한다. 가입 후 `accounts`·`profiles`·센터 연결을 클라이언트에서 순차 생성한다. | 운영 Auth 설정과 redirect를 검증하고 bootstrap을 재시도 안전하게 만든다. 비밀번호 복구 범위를 결정한다. | 안전한 복구, 승인된 OAuth 공급자, 필요 시 MFA/passkey를 Supabase Auth 기반으로 제공한다. | P1 | Supabase Auth Dashboard 설정, OAuth 공급자 결정, 복구 정책 | v1.2 → v2.x |
| Authorization | RLS/RPC, `manager_centers`, custom `center_roles`, role permission, 개인 allow/deny가 최종 권한을 강제한다. UI 사전 가드는 불균일하다. | A/B 센터 권한 매트릭스와 부정 테스트를 고정하고 공통 permission-aware UI guard를 도입한다. | UI와 DB 판정이 일치하고 고위험 작업은 재인증·감사를 포함한다. | P0 | 운영 RLS/RPC 적용 확인, UI 숨김/비활성 정책 | v1.2 |
| Account Linking | 앱 수준의 검증된 social identity 연결·해제 흐름을 확인하지 못했다. | 공급자별 identity 충돌, 기존 Account bootstrap, 복구 정책을 ADR과 테스트로 정의한다. | 이메일 일치만으로 자동 병합하지 않는 안전한 linking/unlinking을 제공한다. | P1 | OAuth 공급자, Supabase identity 기능 검증, 제품 정책 | v2.x |
| Reservation | `classes`·`reservations`, 예약·수강권·대기·취소 RPC와 중복 제약이 구현되어 있다. | 운영 migration 적용을 확인하고 동시성·교차 센터·중복 호출 회귀 테스트를 강화한다. | 센터 정책과 시간대가 일관되고 관측 가능한 예약 처리 체계를 갖춘다. | P0 | 운영 DB/RPC 적용 확인, timezone 결정 | v1.2 |
| Attendance | 매니저 출석·노쇼 처리와 `manager_set_attendance` RPC가 존재한다. | 상태 전이, 권한, 중복 처리와 예약/수강권 영향 테스트를 표준화한다. | 출석 변경 감사와 권한 기반 UI가 일관되게 동작한다. | P1 | 출석 수정 정책, 운영 RPC 적용 확인 | v1.2 |
| Membership (Pass) | `memberships`가 수강권/패스를 나타내며 횟수·기간·정지·환불·공유·예약 조건·자동예약을 지원한다. | 공식 사용자 용어를 확정하고 발급·차감·복원·공유·미배치 규칙 테스트를 통합한다. | 상품 구매부터 발급·예약·환불까지 단일한 수강권 수명주기를 제공한다. | P0 | “수강권/이용권” 명칭, 운영 migration, 환불 정책 | v1.2 |
| Product | `products`는 pass/goods를 저장하고 장바구니·수업 허용 상품과 연결된다. | `memberships`·`product_passes`와의 관계, 판매 상태, 발급 경로를 문서·타입·테스트로 고정한다. | 상품 종류별 주문·발급·사용 규칙이 일관된 카탈로그를 갖춘다. | P1 | 상품/수강권 장기 모델 결정 | v1.2 → v2.x |
| Order | `orders`의 pending/paid/cancelled/done 흐름과 매니저 발급 처리가 존재한다. | 상태 전이와 중복 발급 방지를 RPC·테스트로 검증하고 결제 상태와 분리한다. | 결제·발급·취소·환불이 감사 가능한 주문 수명주기로 연결된다. | P0 | 실제 PG/환불 정책, 운영 RPC 확인 | v1.2 → v2.x |
| Payment | Payment Adapter와 Mock success/failed/cancelled 및 테스트 결제 RPC가 구현됐다. Toss/PortOne은 골격만 있다. | PG를 선택하고 server boundary, idempotency, 상태 모델, sandbox 계약을 설계한다. | 실제 PG 승인·취소·webhook을 server-only secret으로 안전하게 처리한다. | P0 for production | PG 공급자, 가맹점 계약, Route Handler vs Edge Function | v2.x |
| Refund | 수강권 환불 RPC와 일부 고정 정책이 있으나 주문·실결제 환불의 통합 흐름은 아니다. | 수강권/주문/결제 상태별 환불 규칙과 권한·중복 호출을 확정한다. | PG 취소와 내부 원장·수강권 복원을 원자적·감사 가능하게 처리한다. | P0 for production | 환불 사업 정책, PG API, 회계 규칙 | v2.x |
| Notification | `notifications` 테이블, Realtime 알림함, DB 함수·trigger가 존재한다. 외부 푸시·알림톡과 scheduler는 없다. | 운영 Realtime publication/RLS와 cron 호출을 검증하고 알림 이벤트·실패 정책을 정한다. | 승인된 외부 채널과 재시도·관측·사용자 설정을 연결한다. | P1 | Realtime/pg_cron 운영 설정, 메시지 공급자 | v1.2 → v2.x |
| CRM | 센터 회원, 등급, 상태, 메모, 주소, 검색, CSV, 진도, 문의가 구현됐다. 담당회원·상담고객은 미완성이다. | 현재 회원 데이터 경계와 permission을 테스트하고 미완성 화면의 범위를 결정한다. | 승인된 회원 lifecycle과 상담 이력을 권한·감사 기준으로 제공한다. | P2 | CRM 제품 범위, 개인정보 보존 정책 | v2.x |
| Marketing | 카테고리, 홈 배너, 센터 소개·후기·공지 기능이 있다. 캠페인 자동화는 없다. | 노출 데이터와 Platform Admin permission을 검증하고 현재 콘텐츠 기능의 지표 범위를 정한다. | 승인된 캠페인/세그먼트 기능만 개인정보·수신 동의와 함께 추가한다. | P3 | 제품 요구, 수신 동의/개인정보 정책 | v2.x+ |
| Analytics | 매출 화면은 `payments` 조회 결과를 클라이언트에서 집계한다. 통합 제품 분석 체계는 없다. | 지표 정의, 원장 source of truth, 센터 범위와 집계 정확성 테스트를 확정한다. | 서버/DB 기반의 재현 가능하고 권한이 격리된 운영 분석을 제공한다. | P2 | KPI 정의, 결제·포인트 원장 결정 | v2.x |
| Platform SaaS | `/admin`에서 센터 승인·반려, 카테고리, 배너를 관리한다. 과금·플랜·테넌트 셀프서비스는 없다. | Platform Admin guard와 감사, 센터 상태 전이를 강화한다. | 제품 결정이 있을 때만 플랜·과금·운영 정책을 추가한다. | P2 | SaaS 사업 모델, 과금 정책 | v2.x+ |
| Developer Platform | 외부 공개 API/SDK/webhook 플랫폼은 없다. 내부 데이터 접근은 Supabase client/RPC다. | generated DB/RPC 타입과 내부 모듈 계약을 안정화한다. | 외부 파트너 요구가 승인된 경우에만 버전 API, 인증, webhook을 설계한다. | P3 | 파트너 요구, 공개 API 제품 결정 | v2.x+ |
| Multi Center | `centers`, `manager_centers`, 센터 범위 RLS/RPC와 회원 다중 센터 캘린더가 존재한다. | 전체 table/view/RPC/Realtime/Storage의 A/B 센터 격리 테스트와 전환 cleanup을 공통화한다. | 데이터·UI·실시간 이벤트가 완전히 격리되고 승인된 timezone/그룹 모델을 지원한다. | P0 | 운영 policy 적용 확인, timezone/프랜차이즈 결정 | v1.2 → v2.x |
| Role System | owner/manager/trainer 시스템 역할, custom role, role permission, 개인 allow/deny가 구현됐다. | 권한 판정 순서와 마지막 owner 보호를 검증하고 UI guard를 맞춘다. | 모든 고위험 행동이 permission·감사·재인증 정책과 일치한다. | P0 | 역할 관리 범위, owner 이전 정책 | v1.2 |
| Audit Log | 관리자 직접배치 `admin_action_logs` 등 일부 영역별 로그가 있다. 통합 감사 체계는 없다. | 보안·권한·예약·주문 핵심 이벤트와 보존 필드를 정의한다. | 변경 불가성, 조회 권한, 보존 정책을 갖춘 통합 감사 로그를 제공한다. | P1 | 감사 범위, PII/보존 기간 | v1.2 → v2.x |
| Performance | 일부 병렬 조회·N+1 방지와 월 단위 예약 조회가 있다. 공통 성능 기준은 없다. | 주요 화면 query 수, latency, payload 기준을 측정하고 pagination/index를 검증한다. | SLO와 관측 데이터에 따라 캐시·서버 렌더링·query 구조를 선택한다. | P2 | 성능 기준과 운영 관측 환경 | v1.2 → v2.x |
| Security | Supabase Auth, RLS/RPC, Storage policy가 보안 경계다. 운영 적용 상태와 전체 SQL 보안 감사는 미확인이다. | RLS/RPC/Storage/Realtime 부정 테스트와 `SECURITY DEFINER`·grant·search_path 감사를 완료한다. | 외부 연동 secret, 재인증, 보안 이벤트, 개인정보 정책까지 운영 기준을 충족한다. | P0 | 운영 Supabase 접근, Auth/PII 정책 | v1.2 → v2.x |
| Architecture | Next App Router Client Components가 `lib`를 통해 Supabase에 직접 접근한다. Route Handler/Server Action은 없다. | 도메인 모듈 경계와 오류/타입 계약을 정리하고 외부 secret 필요 지점을 식별한다. | 필요한 흐름에만 Route Handler/Edge Function을 둔 명확한 신뢰 경계를 갖춘다. | P1 | server boundary ADR | v1.2 → v2.x |
| Database | Supabase Postgres, RLS, RPC와 누적 SQL 파일이 있다. 운영 적용 migration 목록은 불명확하다. | Supabase migration source of truth, fresh DB 재현, generated TypeScript 타입을 구축한다. | 스키마 drift와 policy/RPC 회귀를 CI에서 차단한다. | P0 | 운영 migration 이력/접근, 도구 결정 | v1.2 |
| Testing | Vitest unit/integration 명령과 테스트 구조가 있다. 브라우저 E2E·fresh DB 기준은 불명확하다. | A/B 센터 fixture, RLS/RPC 통합 테스트, build/lint gate를 표준화한다. | fresh DB부터 핵심 E2E·접근성·외부 sandbox까지 재현 가능한 품질 게이트를 갖춘다. | P0 | 테스트 Supabase 환경, E2E 도구 결정 | v1.2 → v2.x |
| CI/CD | 저장소에 실행 스크립트는 있으나 Master Spec에서 검증된 전체 배포 파이프라인 상태는 확인하지 않았다. | 실제 CI를 조사하고 lint/test/build/migration drift를 필수 gate로 정의한다. | 승인·배포·rollback/forward-fix·운영 smoke가 추적되는 파이프라인을 갖춘다. | P1 | 배포 플랫폼/권한, 운영 환경 | v1.2 → v2.x |

# Roadmap 충돌 기록

현재 `docs/19_Project_Backlog.md`는 이 작업에서 읽기·수정 대상이 아니다. 추후 Backlog와 이 Roadmap의 우선순위가 충돌하면 Backlog를 자동 변경하지 않고 다음 형식으로 기록한다.

| Date | Roadmap Item | Backlog Reference | Conflict | Decision Required |
|---|---|---|---|---|
| - | - | - | 현재 확인된 충돌 없음 | - |

# AI Working Rules

1. AI는 항상 `Current → Intermediate → Target` 순으로 구현한다. 절대로 Current에서 Target으로 점프하지 않는다.
2. `Blocked By`가 있는 기능은 승인 없이 구현하지 않는다.
3. Master Spec가 항상 SSOT다. Roadmap는 구현 순서만 정의한다.
4. Roadmap는 제품 요구사항을 변경하지 않는다.
5. Backlog와 충돌하면 Backlog를 수정하지 말고 Roadmap에 이유를 기록한다.

