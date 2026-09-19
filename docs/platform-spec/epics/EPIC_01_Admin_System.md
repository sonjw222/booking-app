# EPIC 01 — Admin System

Status: Partially Implemented
Version: 1.1.0
Current-State Source: `app/manager/**`, `app/admin/**`, `lib/admin*.ts`, `lib/roles.ts`, permission/RLS SQL
Target-State Status: Incremental hardening
Last Updated: 2026-07-31

## 1. Goal

Platform Admin과 Center Staff가 같은 앱 안에서 각 권한 범위의 운영 기능을 수행한다. 고정 역할이 아니라 센터별 custom role과 permission을 사용한다.

## 2. Current State

### Center operations

- `/manager/*`에서 대시보드, 수업, 룸, 회원, 수강권 조건, 상품, 주문, 매출, 진도, 후기, 공지, 문의, 설정, 스태프 관리
- `manager_centers`로 Account-Center 운영 소속 관리
- `center_roles`의 owner/manager/trainer 및 custom role
- `permissions`, `role_permissions`, 개인 allow/deny
- 관리자 직접배치/무료배치와 `/manager/admin-assignments` 작업 로그

### Platform operations

- `/admin`에서 입점 센터 승인/반려
- 카테고리와 홈 배너 관리
- `accounts.is_platform_admin` 및 RLS로 쓰기 제한

### Staff onboarding

현재 `lib/roles.ts`의 staff 추가는 `manager_centers` row를 생성하는 방식이다. v1.0의 이메일 초대 토큰/만료/수락 흐름은 현재 구현으로 확인되지 않는다.

## 3. Gap

- 세부 permission에 맞춘 메뉴/버튼 노출이 전체 `/manager`에 일관되지 않다.
- 이메일 소유 확인이 있는 초대 onboarding이 없다.
- 마지막 owner 보호와 owner 이전 UX/DB 보장을 전체 흐름에서 재검증해야 한다.
- Platform Admin 페이지별 클라이언트 guard가 균일하지 않다.
- 통합 감사 로그는 없고 직접배치 등 영역별 로그만 있다.

## 4. Target State

- permission-aware navigation/action guard
- RLS/RPC와 동일한 permission 판정의 UI 공통화
- 승인된 경우 이메일 초대, 만료·취소·수락
- owner 이전/마지막 owner 보호
- 역할·permission·센터 상태·주문·예약 관리자 변경의 통합 감사
- Platform Admin 고위험 작업에 recent auth/MFA 검토

## 5. Acceptance Criteria

- A센터 staff가 B센터 관리 데이터를 접근하지 못한다.
- custom role과 개인 allow/deny가 RLS/RPC 결과와 UI에 동일하게 반영된다.
- `ADMIN_ASSIGNMENT`와 `ADMIN_FREE`가 다른 차감 규칙과 감사 기록을 갖는다.
- Platform Admin이 아닌 Account는 센터 승인/카테고리/배너 쓰기를 할 수 없다.
- Target 기능은 구현 전까지 화면/문서에서 현재 기능으로 표시하지 않는다.

## 6. Decision Required / Blocked

| Type | Item |
|---|---|
| Decision Required | staff direct add 유지 vs 이메일 초대 도입 |
| Decision Required | manager가 다른 role/permission을 관리할 수 있는 범위 |
| Decision Required | 직접배치/무료배치/정원초과 permission key |
| Decision Required | 통합 감사 이벤트와 보존 기간 |
| Blocked | 운영 Supabase의 최신 RLS/RPC 적용 확인 |

