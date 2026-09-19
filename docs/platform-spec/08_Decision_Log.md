# Decision Log

Status: Active ADR Index
Version: 1.1.0
Current-State Source: Master Spec and implementation evidence
Target-State Status: Proposed items require approval
Last Updated: 2026-07-31

## Status Values

- `Accepted`: 현재 기준
- `Proposed`: 사용자 결정 필요
- `Superseded`: 대체됨
- `Blocked`: 외부 조건 필요

## Decisions

| ID | Status | Decision | Consequence |
|---|---|---|---|
| ADR-001 | Accepted | Center를 데이터·운영 권한의 범위로 유지한다. | RLS/RPC와 쿼리에 center scope 필요 |
| ADR-002 | Superseded | 조직 관계를 `memberships`로 모델링한다. | v1.1에서 실제 `manager_centers`로 교정 |
| ADR-003 | Superseded | Owner/Admin/Staff/Customer 고정 역할만 사용한다. | 실제 커스텀 역할·permission 모델로 교정 |
| ADR-004 | Proposed | 이메일 초대 기반 staff onboarding을 목표로 한다. | 현재 direct insert 흐름과 정책 차이 분석 필요 |
| ADR-005 | Proposed | 이메일 일치만으로 social account를 자동 병합하지 않는다. | Account Linking 구현 전 승인 필요 |
| ADR-006 | Superseded | 자체 Access/Refresh Token과 sessions/devices를 사용한다. | 현재 Supabase Auth 관리형 세션을 기준으로 함 |
| ADR-007 | Proposed | 비밀번호 재설정 후 세션 정책을 정의한다. | Supabase Auth 기능/제품 UX 검토 필요 |
| ADR-008 | Accepted | 예약 정합성은 Postgres RPC와 DB 제약에서 강제한다. | Client 사전 검사만으로 완료하지 않음 |
| ADR-009 | Superseded | 기술 스택을 미확정으로 둔다. | Next.js 16.2.10 + React 19 + TypeScript + Supabase 확정 |
| ADR-010 | Superseded | 자체 REST `/api/v1`을 현재 API로 사용한다. | 현재 `lib` → Supabase direct/RPC 구조 |
| ADR-011 | Proposed | 외부 secret이 필요한 기능에만 server boundary를 추가한다. | Route Handler/Edge Function 선택 필요 |
| ADR-012 | Accepted | `memberships`의 공식 기술 의미는 수강권/패스다. | 조직 관계와 용어 충돌 금지 |
| ADR-013 | Accepted | 예약·수업·상품·사람의 기술 용어는 `reservations`, `classes`, `products`, `accounts/profiles`를 따른다. | 문서와 코드 검색 일치 |
| ADR-014 | Accepted | 관리자 직접배치와 무료배치를 예약의 1급 유형으로 문서화한다. | `ADMIN_ASSIGNMENT`, `ADMIN_FREE` 및 audit 반영 |
| ADR-015 | Accepted | Mock Payment는 Current State, 실제 PG는 Target/Blocked로 분리한다. | 테스트 결제를 운영 결제로 표현하지 않음 |
| ADR-016 | Accepted | **Master Spec v1.1 교정:** 실제 코드가 Current State의 기준이며 기존 미구현 설계는 Target/Future로 이동한다. | 구현과 목표의 혼합 금지, 용어 맵 유지 |

## Open Decisions

| ID | Decision Required | Options/Considerations |
|---|---|---|
| DR-01 | 실제 PG | Toss / PortOne / 기타; webhook와 환불 |
| DR-02 | OAuth/Account Linking | 카카오·애플·네이버 범위, 충돌/복구 정책 |
| DR-03 | Staff onboarding | direct assignment 유지 / 이메일 초대 도입 |
| DR-04 | Auth recovery | password reset, MFA/passkey, session/device UX |
| DR-05 | Admin assignment permission | 직접배치/무료배치/정원초과 key 및 정지·탈퇴 정책 |
| DR-06 | Timezone | 한국 단일 timezone / 센터별 IANA timezone |
| DR-07 | Server boundary | Next Route Handler / Supabase Edge Function / 혼합 |
| DR-08 | Migration source of truth | Supabase CLI migration 구조와 운영 적용 추적 |

## ADR Template

```md
### ADR-NNN: Title
- Status:
- Date:
- Context:
- Current State:
- Decision:
- Alternatives:
- Consequences:
```

