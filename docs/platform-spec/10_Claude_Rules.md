# Claude / AI Agent Rules

Status: Active Repository Rules
Version: 1.1.0
Current-State Source: `/Users/sonjw/Documents/booking-app` repository structure and Master Spec
Target-State Status: Update with architecture changes
Last Updated: 2026-07-31

## 1. Source of Truth

1. 실제 구현 판단은 `package.json`, `app/**`, `lib/**`, SQL, tests 순으로 증거를 확인한다.
2. `docs/platform-spec`에서 Current State와 Target State를 혼동하지 않는다.
3. 저장소 루트에 프로젝트 전용 `AGENTS.md`가 있다고 가정하지 않는다.
4. 존재하지 않는 `sources/`를 참조하거나 관련 규칙을 만들지 않는다.
5. `node_modules/**/AGENTS.md`는 해당 dependency 내부 작업이 아니면 프로젝트 지침이 아니다.

## 2. Read-Only Rules for Documentation Audits

문서 교정 요청에서는 사용자가 별도로 허용하지 않는 한 다음을 수정하지 않는다.

- `app/**`, `lib/**`, `components/**`
- 모든 `*.sql`
- `tests/**`, 설정 및 환경 파일
- `docs/19_Project_Backlog.md`
- `tmp/**`

작업 범위가 `docs/platform-spec/**`로 지정되면 그 밖의 기존 `docs/**`도 수정하지 않는다.

## 3. Current Architecture Rules

- 현재 스택을 미확정으로 표현하지 않는다.
- 자체 REST endpoint, Server Action, token service가 있다고 가정하지 않는다.
- Current State의 데이터 흐름은 Client Component → `lib` → Supabase다.
- Supabase Auth 세션을 자체 Refresh Token 시스템으로 설명하지 않는다.
- RLS/RPC가 최종 권한·정합성 계층이다.
- 저장소 SQL의 존재를 운영 적용 증거로 간주하지 않는다.

## 4. Terminology Rules

- `accounts`: 로그인/앱 권한 단위
- `profiles`: 수강·예약 주체
- `manager_centers`: 센터 운영 소속
- `center_roles`/permissions: 커스텀 역할·권한
- `memberships`: 수강권/패스
- `classes`: 수업
- `reservations`: 예약
- `products`: 판매 상품(수강권 상품 포함)
- `orders`: 주문
- `payments`: 매출/결제 기록

일반적인 SaaS 의미의 membership을 조직 소속에 사용하지 않는다. 자세한 매핑은 [Terminology Map](./11_Terminology_Map.md)을 따른다.

## 5. Security and Data Rules

- 브라우저 입력의 center/account/profile/permission 값을 권한 근거로 신뢰하지 않는다.
- 민감 조회·쓰기는 RLS 또는 permission-aware RPC 검증이 있어야 한다.
- service-role/PG secret을 `NEXT_PUBLIC_*` 또는 Client Component에 넣지 않는다.
- 예약/차감/직접배치/결제는 다중 쓰기를 클라이언트에서 흉내 내지 않고 RPC/server boundary에서 원자 처리한다.
- UI guard는 RLS/RPC를 대체하지 않는다.
- Mock 결제를 실제 결제로 표현하지 않는다.

## 6. Change Discipline

| Change | Required review |
|---|---|
| Table/RPC/RLS | SQL migration, generated types, integration tests, `02_Database` |
| Supabase data module | callers, RLS/RPC, error handling, `03_API` |
| Auth/permission | negative tests, `05_Security`, Epic |
| Route/UI | mode/profile/center context, accessibility, `04_UI_UX` |
| Product term | `11_Terminology_Map` |
| Architecture decision | `08_Decision_Log` |
| Release-visible change | `09_Change_Log` |

## 7. Target-State Discipline

Account Linking, password recovery, sessions/devices, Route Handler, outbox, actual PG는 구현 증거가 생길 때까지 Future/Target State다. 새 기술을 도입하기 전 Current Gap, 선택 이유, security boundary, migration plan을 ADR로 남긴다.

## 8. Completion Report

변경 파일, 구현 증거, 테스트, 남은 Gap/Decision/Blocked를 보고한다. 실행하지 않은 테스트나 운영 적용을 완료로 말하지 않는다. 사용자 미추적 파일과 관련 없는 변경을 스테이징·삭제·수정하지 않는다.

