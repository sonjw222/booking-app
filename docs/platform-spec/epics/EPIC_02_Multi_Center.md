# EPIC 02 — Multi-Center

Status: Implemented with Gaps
Version: 1.1.0
Current-State Source: `centers`, `manager_centers`, center-scoped tables/RLS, member calendar and manager modules
Target-State Status: Isolation and UX hardening
Last Updated: 2026-07-31

## 1. Goal

한 Account가 여러 Center를 회원 또는 운영자 관점에서 이용하면서 데이터와 권한이 섞이지 않게 한다.

## 2. Current State

- Center 운영 단위: `centers`
- 운영 소속: `manager_centers`
- 센터별 역할: `center_roles`
- 회원 측 센터 관계: Profile이 보유한 `memberships`, 예약, `center_members`
- 센터 범위 데이터: classes, reservations(수업 경유), products, orders, payments, settings, rooms 등
- 매니저 대시보드와 관리 화면에서 센터 선택
- 회원 예약 캘린더에서 보유 수강권이 있는 여러 센터의 수업 통합 조회
- 계정 단위 센터 색상 `member_center_colors`

## 3. Isolation Boundary

- Client query에 center filter가 있어도 RLS/RPC가 관계를 다시 검증해야 한다.
- `manager_centers`는 조직 소속, `memberships`는 수강권이므로 서로 대체하지 않는다.
- Profile 소유권과 Center 접근 권한을 모두 확인한다.
- Realtime, Storage, views, RPC도 같은 center/profile 경계를 적용한다.

## 4. Gap

- 모든 table/view/RPC의 교차 센터 RLS 회귀가 단일 매트릭스로 정리되지 않았다.
- 센터 전환 시 모든 캐시·선택·subscription 정리 규칙이 공통화되지 않았다.
- 일부 KST 고정 로직은 센터별 timezone 확장과 맞지 않는다.
- 운영 SQL 적용 상태가 불명확하면 코드상의 격리 가정과 운영 정책이 달라질 수 있다.
- 프랜차이즈/상위 조직 계층은 현재 모델에 없다.

## 5. Target State

- 모든 center-scoped entity의 A/B 센터 부정 테스트
- 공통 Center Context와 전환 cleanup
- permission-aware UI
- 센터별 IANA timezone을 선택하는 경우 UTC 저장/현지 표시 일관성
- Storage/Reatime/view까지 포함한 tenant isolation checklist

## 6. Acceptance Criteria

- A센터의 Account/Profile ID를 B센터 요청에 넣어도 정보가 노출되지 않는다.
- Center switch 후 이전 Center의 상세·필터·실시간 이벤트가 남지 않는다.
- 회원은 자신의 수강권/프로필 관계에 맞는 센터·수업만 조작한다.
- Platform Admin과 Center Staff 권한은 독립적으로 판정한다.

## 7. Decision Required / Blocked

- Decision Required: 국내 단일 timezone인지 다지역 센터인지
- Decision Required: 프랜차이즈/센터 그룹이 제품 범위인지
- Decision Required: 회원 데이터의 센터 간 공유 정책
- Blocked: 운영 RLS, Realtime publication, Storage policy 검증

