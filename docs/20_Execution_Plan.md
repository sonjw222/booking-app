# 20. Execution Plan v2

> **버전**: v2 (v1은 채팅 응답으로만 제시되었고 파일로 저장된 적이 없어, 이 파일이 최초로 저장되는 버전입니다 — 사용자 요청에 따라 구조를 개선한 v2로 표기합니다.)
> **작성일**: 2026-07-31
> **범위**: 이 문서는 Execution Plan만 다룹니다. `docs/19_Project_Backlog.md`(Backlog), `docs/platform-spec/*`(Master Spec/Roadmap)의 내용은 이 작업에서 변경하지 않았습니다(읽기 전용 참조만).

## ⚠️ 저장소 상태 변경 발견 (투명성 고지)

이 Execution Plan v1(이전 대화 턴)을 작성한 이후, 저장소에 다음과 같은 변경이 있었음을 확인했습니다(제가 만든 변경이 아니며, 다른 세션/작업자에 의한 것으로 추정됩니다).

- `git log`에 `docs: add Project Principles`부터 `docs: add booking platform master spec v1.0`까지 다수의 신규 커밋이 `main`에 추가됨(제가 마지막으로 인지한 시점은 `b06204f Merge pull request #4`였습니다).
- `docs/` 최상위에 `11_Development_Guide.md`, `12_Deployment.md`, `13_Design_System.md`, `14_Coding_Convention.md`, `15_Roadmap.md`, `16_Troubleshooting.md`, `17_API_Examples.md`가 신규로 커밋되어 존재합니다.
- `docs/platform-spec/00~10.md` 및 `epics/EPIC_01~03.md` 14개 파일이 커밋된 이후 **다시 수정된 상태(uncommitted, `git status`상 `M`)**입니다.
- `docs/platform-spec/11_Terminology_Map.md`, `12_Roadmap.md`, `13_Implementation_Roadmap.md`, `14_Backlog_Guide.md`가 신규(uncommitted, `??`)로 존재합니다.

**확인된 내용(읽기 전용으로 확인, 수정하지 않음)**: 새로 추가된 `platform-spec`의 `12_Roadmap.md`/`13_Implementation_Roadmap.md`/`14_Backlog_Guide.md`는 이 대화에서 제가 제안했던 "Master Spec → Roadmap → Backlog → Execution Plan" 계층 구조와 "용어 매핑표"、"Phase 0~7 구현 순서"를 이미 상당 부분 구체화해 놓았습니다. 특히 `11_Terminology_Map.md`는 제가 지적했던 `memberships` 용어 충돌을 이미 공식적으로 정리했습니다. 이는 **이번 v2 작업 지시("기존 Master Spec 변경 금지", "Roadmap 변경 금지")와 정확히 일치하는 산출물**로 보이며, 제가 이전에 제안했던 `DOC-001`/`DOC-002` Issue의 상당 부분이 이미 다른 트랙에서 진행되었을 가능성이 있습니다. 이 Execution Plan에서는 해당 두 Issue를 삭제하지 않고 유지하되, `Implementation Notes`에 이 사실을 기록하고 "착수 전 최신 문서를 먼저 검토"하도록 표시했습니다(아래 DOC-001, DOC-002 참고).

이 발견에 대한 상세 확인/처리는 사용자의 판단이 필요하며, 이 Execution Plan 개선 작업 범위를 벗어나 임의로 추가 조사하지 않았습니다.

## Milestone ↔ Implementation Roadmap Phase 정렬 안내

위 발견에 따라, v1에서 제가 임의로 붙였던 Milestone 이름(M0~M6)을 `docs/platform-spec/13_Implementation_Roadmap.md`가 이미 정의한 **Phase 0~7** 체계에 맞춰 재정렬했습니다. **Issue 자체, 우선순위, 시간추정은 전혀 변경하지 않았습니다** — 각 Issue가 속하는 Milestone 레이블만 공식 Phase 이름으로 교체했습니다.

| Phase | 정의(Implementation Roadmap 기준) | 이 Execution Plan에서 해당하는 Issue 그룹 |
|---|---|---|
| Phase 0 | 문서 정합성·운영 설정·Supabase 설정 | DOC-*, ARCH-008 |
| Phase 1 | Security·RLS·권한·Data Isolation | SEC-*, ACL-*, DB-001~003, CRM-001~002 |
| Phase 2 | Database·Migration·RPC·Type | DB-004~011, ARCH-004~005, LEGACY-*, TEST-002 |
| Phase 3 | Architecture·Refactoring·Performance | PERF-*, ARCH-001~003, ARCH-006~007, ARCH-009 |
| Phase 4 | Reservation·Attendance·Membership·Order | TEST-001 |
| Phase 5 | Payment·Refund·PG | PAY-001~006 |
| Phase 6 | Notification·CRM·Analytics | NOTIF-*, CRM-003~005, PAY-007~009 |
| Phase 7 | Marketing·Platform SaaS·Developer Platform | DEFER-* |

## 1. 공통 Issue Template

모든 Issue는 아래 템플릿을 따릅니다. 신규 Issue의 `Status` 기본값은 `Todo`입니다.

```
Issue ID:
Title:
Epic:
Milestone (Phase):
Priority:            (P0 / P1 / P2 / P3 / Blocked)
Risk:                (Low / Medium / High / Critical)
Estimated Time:
Status:              (Todo / Ready / In Progress / Review / Testing / Done / Released)
Blocked By:
Related Master Spec:
Related Roadmap:
Related Backlog:
Expected Files:
Out of Scope:
Implementation Notes:
Definition of Done:
Verification Checklist:
  ☐ TypeScript Build 통과
  ☐ Lint 통과
  ☐ 기존 기능 회귀 없음
  ☐ 모바일 동작 확인
  ☐ 관련 테스트 통과
  (Issue별 추가 항목)
```

## 2. Issue 목록

총 70개 Issue (활성 65개 + Deferred 대기목록 5개). 우선순위/시간추정은 v1과 동일하게 유지했습니다.

### `SEC-001` 공지사항(center_announcements.body) 저장 시 HTML sanitize 적용

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| SEC-001 (구 A1) | 공지사항(center_announcements.body) 저장 시 HTML sanitize 적용 | Security Emergency | Phase 1 | P0 | Low | 6h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 05_Security.md §6 애플리케이션 보안(입력 검증)
- **Related Roadmap**: Security
- **Related Backlog**: 신규(Backlog 미포함, CTO Audit 발견)
- **Expected Files**: app/manager/announcements/page.tsx, lib/announcements.ts, lib/security.ts(신규 유틸)
- **Out of Scope**: Payment, UI 리디자인, Webhook, Database Schema, 리뷰답변/소개블록 sanitize(SEC-002/003에서 별도 처리)
- **Implementation Notes**: 저장 직전(create/updateAnnouncement 호출 전) sanitize 적용. 렌더 시점(app/notifications/page.tsx:95)도 방어적으로 이중 검증 권장.
- **Definition of Done**:
  - [ ] 공지 저장 시 <script>/on* 이벤트핸들러/javascript: 스킴이 제거됨을 확인
  - [ ] 기존 정상 서식(줄바꿈/폰트크기/정렬)은 그대로 유지됨
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 악성 payload(quoted/unquoted 이벤트핸들러) 목록 기준 회귀 테스트 통과

### `SEC-002` 리뷰 답변(center_reviews.reply) 저장 시 HTML sanitize 적용

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| SEC-002 (구 A2) | 리뷰 답변(center_reviews.reply) 저장 시 HTML sanitize 적용 | Security Emergency | Phase 1 | P0 | Low | 6h | Todo |

- **Blocked By**: SEC-001(공통 sanitizer 유틸 재사용 권장)
- **Related Master Spec**: 05_Security.md §6
- **Related Roadmap**: Security
- **Related Backlog**: 신규(Backlog 미포함, CTO Audit 발견)
- **Expected Files**: app/manager/reviews/page.tsx, lib/reviews.ts, lib/security.ts
- **Out of Scope**: Payment, 리뷰 평점/사진 로직, Database Schema
- **Implementation Notes**: 공개 페이지(app/center/[id]/page.tsx:543)에 렌더되므로 비로그인 방문자까지 영향받는 최우선 경로.
- **Definition of Done**:
  - [ ] replyToReview 저장 경로에 sanitize 적용
  - [ ] 공개 센터 페이지에서 악성 payload 실행 안 됨 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 비로그인 상태에서 센터 상세 페이지 직접 확인

### `SEC-003` 센터소개(intro_blocks.html) 정규식 sanitizer를 파서기반으로 교체

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| SEC-003 (구 A3) | 센터소개(intro_blocks.html) 정규식 sanitizer를 파서기반으로 교체 | Security Emergency | Phase 1 | P0 | Low | 8h | Todo |

- **Blocked By**: SEC-001(공통 sanitizer 유틸)
- **Related Master Spec**: 05_Security.md §6
- **Related Roadmap**: Security
- **Related Backlog**: 신규(Backlog 미포함, CTO Audit 발견)
- **Expected Files**: app/manager/center-info/page.tsx
- **Out of Scope**: Payment, 지도(MapPicker) 로직, Database Schema
- **Implementation Notes**: 기존 sanitizeHtml()(page.tsx:30-41)는 unquoted 이벤트핸들러(<svg onload=> 등) 우회 가능. DOMPurify 등 파서기반으로 교체.
- **Definition of Done**:
  - [ ] 기존 sanitizeHtml() 호출부(page.tsx:146)가 신규 sanitizer로 교체됨
  - [ ] unquoted 이벤트핸들러 payload가 제거됨을 테스트로 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 기존 저장된 intro_blocks 데이터가 깨지지 않고 정상 렌더되는지 확인

### `SEC-004` Sanitize 회귀 테스트 추가(공지/리뷰/소개 3종)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| SEC-004 (구 A4) | Sanitize 회귀 테스트 추가(공지/리뷰/소개 3종) | Security Emergency | Phase 1 | P0 | Low | 4h | Todo |

- **Blocked By**: SEC-001, SEC-002, SEC-003
- **Related Master Spec**: 06_Testing.md
- **Related Roadmap**: Testing
- **Related Backlog**: 신규(Backlog 미포함, CTO Audit 발견)
- **Expected Files**: tests/unit/security.test.ts(신규), lib/security.ts
- **Out of Scope**: 신규 기능 구현, UI 변경
- **Implementation Notes**: 악성 payload 목록(스크립트 태그/quoted·unquoted 이벤트핸들러/javascript: 스킴/HTML엔티티 우회)을 fixture로 관리.
- **Definition of Done**:
  - [ ] 3개 소스 각각에 대해 최소 5개 이상의 payload 케이스가 자동 테스트로 검증됨
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] npm run test 통과

### `SEC-005` Supabase 세션 저장 방식 확인 및 XSS 영향범위 문서화

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| SEC-005 (구 A5) | Supabase 세션 저장 방식 확인 및 XSS 영향범위 문서화 | Security Emergency | Phase 1 | P0 | Low | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 05_Security.md §4 세션과 기기
- **Related Roadmap**: Security
- **Related Backlog**: 신규(Backlog 미포함, CTO Audit 발견)
- **Expected Files**: lib/supabaseClient.ts
- **Out of Scope**: 세션 저장방식 변경(별도 Decision 필요), 코드 수정
- **Implementation Notes**: createClient() 커스텀 storage 옵션 여부 확인, XSS 성공 시 세션탈취 가능성 결론 문서화(조사 Task, 코드변경 없음).
- **Definition of Done**:
  - [ ] 세션 저장 위치(localStorage 등) 확인 결과 기록
  - [ ] XSS 영향범위(SEC-001~003과 연계) 문서화
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `SEC-006` 소셜 로그인 계정 자동 병합 여부 검증(운영 Supabase Auth 설정)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| SEC-006 (구 A6) | 소셜 로그인 계정 자동 병합 여부 검증(운영 Supabase Auth 설정) | Security Emergency | Phase 1 | P0 | Medium | 4h | Todo |

- **Blocked By**: 운영 Supabase 콘솔 접근 권한
- **Related Master Spec**: platform-spec/08_Decision_Log.md ADR-005 상당(자동 병합 금지)
- **Related Roadmap**: Account Linking
- **Related Backlog**: 신규(platform-spec Gap GAP-A02)
- **Expected Files**: app/login/page.tsx
- **Out of Scope**: Account Linking UI 구현(검증 후 별도 Issue), 코드 수정
- **Implementation Notes**: Manual Linking 설정값 확인 후 자동병합 활성 상태면 후속 Issue 생성.
- **Definition of Done**:
  - [ ] Supabase Auth Manual Linking 설정값 확인 및 기록
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `SEC-007` RLS 미적용 17개 테이블 — 영향 분석(1/5)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| SEC-007 (구 A7) | RLS 미적용 17개 테이블 — 영향 분석(1/5) | Security Emergency | Phase 1 | P0 | Critical | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 02_Database.md, 05_Security.md
- **Related Roadmap**: Security / Multi Center
- **Related Backlog**: E11-F1-T1
- **Expected Files**: schema.sql(읽기전용 분석), *.sql(읽기전용 분석)
- **Out of Scope**: 실제 정책 작성, 코드/SQL 수정
- **Implementation Notes**: 개인정보 포함 가능 테이블(leads, contracts 등) 우선 확인. 재검증 결과 17개 테이블 목록 재확인 완료.
- **Definition of Done**:
  - [ ] 17개 테이블 각각의 민감정보 포함여부/현재 노출범위가 표로 정리됨
  - [ ] 처리 우선순위 산정 완료
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(분석 Task)

### `SEC-008` RLS 정책 설계(2/5)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| SEC-008 (구 A8) | RLS 정책 설계(2/5) | Security Emergency | Phase 1 | P0 | Critical | 12h | Todo |

- **Blocked By**: SEC-007
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Security / Multi Center
- **Related Backlog**: E11-F1-T2
- **Expected Files**: fix_missing_rls_batch1.sql(설계 초안, 미적용)
- **Out of Scope**: 실제 운영 DB 적용(SEC-008은 설계까지만, 적용은 DB-002), 코드 수정
- **Implementation Notes**: 테이블별 역할기반 정책 SQL 초안 작성. 기존 유사 패턴(center_members 등) 재사용 검토.
- **Definition of Done**:
  - [ ] 17개 테이블 전부 정책 설계안(SQL 초안 포함) 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(설계 Task)

### `SEC-009` 플랫폼 관리자 셀프승격 경로 재확인

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| SEC-009 (구 A9) | 플랫폼 관리자 셀프승격 경로 재확인 | Security Emergency | Phase 1 | P0 | Medium | 3h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 05_Security.md §5, 08_Decision_Log.md(플랫폼 관리자 원칙)
- **Related Roadmap**: Authorization
- **Related Backlog**: 신규(CTO Audit 확인)
- **Expected Files**: app/login/page.tsx, *.sql(is_platform_admin 관련, 읽기전용)
- **Out of Scope**: 코드 수정
- **Implementation Notes**: 가입 흐름 및 관련 RPC에 is_platform_admin 셀프설정 경로 없음을 코드 근거로 재확인·문서화.
- **Definition of Done**:
  - [ ] 셀프승격 경로 없음이 코드 인용과 함께 문서화됨
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `ACL-001` /admin/categories, /admin/banners 플랫폼관리자 가드 추가

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ACL-001 (구 B1) | /admin/categories, /admin/banners 플랫폼관리자 가드 추가 | Access Control Gaps | Phase 1 | P0 | Low | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 04_UI_UX.md §1(권한없는 기능은 숨기되 서버가 재차단)
- **Related Roadmap**: Authorization
- **Related Backlog**: E02-F1-T1
- **Expected Files**: app/admin/categories/page.tsx, app/admin/banners/page.tsx, lib/admin.ts
- **Out of Scope**: Payment, Database Schema, 다른 admin 화면 리팩토링
- **Implementation Notes**: app/admin/centers/page.tsx의 checkPlatformAdmin() 패턴 재사용.
- **Definition of Done**:
  - [ ] 비관리자 계정 접근 시 콘텐츠 대신 접근불가 안내
  - [ ] 관리자 계정은 기존과 동일하게 동작
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 일반 회원 계정으로 두 라우트 직접 접근 테스트

### `ACL-002` /manager/inquiries, /manager/notifications 소속센터 가드 추가

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ACL-002 (구 B2) | /manager/inquiries, /manager/notifications 소속센터 가드 추가 | Access Control Gaps | Phase 1 | P0 | Low | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 04_UI_UX.md §1
- **Related Roadmap**: Multi Center
- **Related Backlog**: E08-F1-T1
- **Expected Files**: app/manager/inquiries/page.tsx, app/manager/notifications/page.tsx
- **Out of Scope**: Realtime 로직 변경, Database Schema
- **Implementation Notes**: 다른 매니저 화면과 동일한 fetchMyCenters() 가드 패턴 적용.
- **Definition of Done**:
  - [ ] 비소속 계정 접근 시 접근불가 안내
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 비소속 계정으로 두 라우트 접근 테스트

### `ACL-003` /manager/staff/permissions 오너전용 가드 추가

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ACL-003 (구 B3) | /manager/staff/permissions 오너전용 가드 추가 | Access Control Gaps | Phase 1 | P0 | Low | 3h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 04_UI_UX.md §1
- **Related Roadmap**: Role System
- **Related Backlog**: E07-F1-T1
- **Expected Files**: app/manager/staff/permissions/page.tsx
- **Out of Scope**: 권한 데이터 모델 변경
- **Implementation Notes**: fetchMyCenters() + 오너 역할 확인 가드 추가.
- **Definition of Done**:
  - [ ] 비오너 계정 접근 시 접근불가 안내
  - [ ] 오너 계정은 기존과 동일하게 동작
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 비소속/일반직원/오너 계정 각각 접근 테스트

### `ACL-004` chat_messages 사용여부 확인 및 정책/삭제 결정

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ACL-004 (구 B4) | chat_messages 사용여부 확인 및 정책/삭제 결정 | Access Control Gaps | Phase 2 | P0 | Medium | 5h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Security
- **Related Backlog**: 신규(CTO Audit, 기존 E10-F1-T2 유사)
- **Expected Files**: schema.sql(읽기전용)
- **Out of Scope**: 정책 실제 추가(결론 확정 후 별도 Issue), 테이블 DROP
- **Implementation Notes**: RLS enable(schema.sql:1321)되었으나 policy 0건 재확인. 사용여부 결론 후 정책 추가 or 삭제후보 확정.
- **Definition of Done**:
  - [ ] 사용여부 결론
  - [ ] 결론에 따른 후속 조치(정책추가 or 삭제후보) 문서화
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `ACL-005` 세부 권한 기반 UI 표시 제어(1차: 매니저 메뉴)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ACL-005 (구 B5) | 세부 권한 기반 UI 표시 제어(1차: 매니저 메뉴) | Access Control Gaps | Phase 1 | P1 | Medium | 12h | Todo |

- **Blocked By**: ACL-001, ACL-002, ACL-003
- **Related Master Spec**: 00_Project_Principles.md 핵심원칙3(최소권한)
- **Related Roadmap**: Role System
- **Related Backlog**: E07-F2-T1
- **Expected Files**: app/manager/page.tsx, lib/roles.ts
- **Out of Scope**: 권한 카탈로그(permissions) 확장, 나머지 화면 전체 적용(2차 이후 별도 Issue)
- **Implementation Notes**: effectiveState()를 app/manager/page.tsx 메뉴 노출에 적용.
- **Definition of Done**:
  - [ ] 권한 없는 메뉴가 숨겨지거나 비활성화됨
  - [ ] 서버 차단과 화면 노출 결과 일치
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 권한 제거된 테스트 계정으로 메뉴 노출 확인

### `DB-001` RLS 역할별 회귀 테스트 스위트 구축(3/5)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-001 (구 C1) | RLS 역할별 회귀 테스트 스위트 구축(3/5) | Database Integrity & SSOT | Phase 1 | P0 | Critical | 12h | Todo |

- **Blocked By**: SEC-007, SEC-008
- **Related Master Spec**: 06_Testing.md
- **Related Roadmap**: Security
- **Related Backlog**: E11-F1-T3
- **Expected Files**: tests/integration/rls-regression.test.ts(신규)
- **Out of Scope**: 정책 실제 적용(DB-002에서 진행)
- **Implementation Notes**: 4역할(회원/매니저/타센터매니저/관리자)×17테이블 시나리오.
- **Definition of Done**:
  - [ ] CI에서 역할별 접근 테스트 실행
  - [ ] 적용 전 기준(현재 상태) 결과 기록
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] npm run test:integration 통과

### `DB-002` RLS 정책 단계적 적용(4/5)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-002 (구 C2) | RLS 정책 단계적 적용(4/5) | Database Integrity & SSOT | Phase 1 | P0 | Critical | 12h | Todo |

- **Blocked By**: DB-001
- **Related Master Spec**: 02_Database.md, 10_Claude_Rules.md §6(migration)
- **Related Roadmap**: Security
- **Related Backlog**: E11-F1-T4
- **Expected Files**: fix_missing_rls_batch1.sql(신규, 실제 적용)
- **Out of Scope**: 레거시 확정 안 된 테이블 성급한 삭제
- **Implementation Notes**: 배치별 적용 + 매 배치 후 DB-001 회귀테스트 재실행. **Risk Critical — 별도 Review 필수(Execution Rule 3).**
- **Definition of Done**:
  - [ ] 17개 테이블 전부 RLS+정책 적용
  - [ ] 각 배치 후 회귀테스트 통과
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 비인가 계정 직접 조회 시도 후 거부 확인
  - [ ] 별도 리뷰어 승인

### `DB-003` RLS 적용 QA 및 운영 DB 검증(5/5)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-003 (구 C3) | RLS 적용 QA 및 운영 DB 검증(5/5) | Database Integrity & SSOT | Phase 1 | P0 | Critical | 8h | Todo |

- **Blocked By**: DB-002
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Security
- **Related Backlog**: E11-F1-T5
- **Expected Files**: (운영 Supabase 콘솔 검증, 코드 변경 없음)
- **Out of Scope**: 신규 기능 추가
- **Implementation Notes**: 운영 DB 정책 diff + 핵심 시나리오(예약/결제/로그인) 회귀 확인.
- **Definition of Done**:
  - [ ] 운영 정책이 저장소 SQL과 일치함 확인
  - [ ] 핵심 기능 회귀 없음 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] npm run test:all 전체 통과
  - [ ] 별도 리뷰어 승인

### `DB-004` 중복 RPC 목록 25개로 재확정(calc_deadline 반영)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-004 (구 C4) | 중복 RPC 목록 25개로 재확정(calc_deadline 반영) | Database Integrity & SSOT | Phase 2 | P0 | Low | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Database
- **Related Backlog**: E11-F2-T5(갱신)
- **Expected Files**: (문서 조사, 코드변경 없음)
- **Out of Scope**: 실제 RPC 수정
- **Implementation Notes**: 기존 22개 목록에 calc_deadline 등 누락분 반영, 25개로 확정.
- **Definition of Done**:
  - [ ] 25개 함수 목록 확정 및 근거(파일별 정의 위치) 문서화
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `DB-005` 운영 Supabase RPC 실제 정의 대조(25개)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-005 (구 C5) | 운영 Supabase RPC 실제 정의 대조(25개) | Database Integrity & SSOT | Phase 2 | P0 | High | 16h | Todo |

- **Blocked By**: DB-004
- **Related Master Spec**: 02_Database.md, 12_Roadmap.md(Database Feature: '운영 migration 적용 확인')
- **Related Roadmap**: Database
- **Related Backlog**: E11-F2-T5
- **Expected Files**: (운영 Supabase SQL Editor 조회, 코드변경 없음)
- **Out of Scope**: 불일치 발견시 실제 수정(별도 Issue)
- **Implementation Notes**: pg_get_functiondef()로 실제 본문 추출 후 저장소 diff.
- **Definition of Done**:
  - [ ] 25개 함수 전부 운영본-저장소 일치/불일치 표 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `DB-006` Dead function usable_memberships 처리 결정

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-006 (구 C6) | Dead function usable_memberships 처리 결정 | Database Integrity & SSOT | Phase 2 | P1 | Low | 4h | Todo |

- **Blocked By**: DB-005
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Database
- **Related Backlog**: 신규(CTO Audit 발견)
- **Expected Files**: (조사, 코드변경 없음)
- **Out of Scope**: 실제 함수 DROP(결정 후 별도 Issue)
- **Implementation Notes**: 4개 파일에서 재정의되나 실제 호출지점 0건 확인(JS/SQL 양쪽). 삭제 or 실사용 전환 결정.
- **Definition of Done**:
  - [ ] 처리방침 결정 및 문서화
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `DB-007` SQL 적용순서 정리

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-007 (구 C7) | SQL 적용순서 정리 | Database Integrity & SSOT | Phase 2 | P0 | Low | 6h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 10_Claude_Rules.md §6
- **Related Roadmap**: Database
- **Related Backlog**: 신규(System 항목)
- **Expected Files**: docs/DATABASE.md(참고용, 수정은 별도 승인)
- **Out of Scope**: 마이그레이션 도구(Prisma 등) 도입
- **Implementation Notes**: 73개 SQL 파일 의존순서 목록 작성(문서 산출물, docs/DATABASE.md 자체 수정은 이 Issue 범위 밖).
- **Definition of Done**:
  - [ ] 73개 파일 순서 목록 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(문서화 Task)

### `DB-008` Migration history ledger 작성

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-008 (구 C8) | Migration history ledger 작성 | Database Integrity & SSOT | Phase 2 | P0 | Low | 6h | Todo |

- **Blocked By**: DB-007
- **Related Master Spec**: 10_Claude_Rules.md §6
- **Related Roadmap**: Database
- **Related Backlog**: 신규
- **Expected Files**: (신규 ledger 문서 산출물)
- **Out of Scope**: 실제 운영 적용 여부 강제 검증(별도 조사 필요)
- **Implementation Notes**: 적용이력 문서 신설.
- **Definition of Done**:
  - [ ] ledger 문서 초안 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(문서화 Task)

### `DB-009` 운영 적용 체크리스트

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-009 (구 C9) | 운영 적용 체크리스트 | Database Integrity & SSOT | Phase 2 | P1 | Low | 4h | Todo |

- **Blocked By**: DB-007
- **Related Master Spec**: 10_Claude_Rules.md §6
- **Related Roadmap**: Database
- **Related Backlog**: 신규
- **Expected Files**: (신규 체크리스트 문서 산출물)
- **Out of Scope**: (별도 없음)
- **Implementation Notes**: 적용 전/중/후 체크리스트.
- **Definition of Done**:
  - [ ] 체크리스트 초안 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(문서화 Task)

### `DB-010` Migration rollback 기준 정리

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-010 (구 C10) | Migration rollback 기준 정리 | Database Integrity & SSOT | Phase 2 | P1 | Low | 4h | Todo |

- **Blocked By**: DB-007
- **Related Master Spec**: 10_Claude_Rules.md §6
- **Related Roadmap**: Database
- **Related Backlog**: 신규
- **Expected Files**: (신규 문서 산출물)
- **Out of Scope**: 기존 SQL 파일 수정
- **Implementation Notes**: 유형별(컬럼추가/함수교체/백필 등) 표준 rollback 절차.
- **Definition of Done**:
  - [ ] rollback 기준 문서 초안 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(문서화 Task)

### `DB-011` 파괴적 스크립트 3종 분리/경고 표준화

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DB-011 (구 C11) | 파괴적 스크립트 3종 분리/경고 표준화 | Database Integrity & SSOT | Phase 2 | P1 | Medium | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 10_Claude_Rules.md §6(destructive migration 명시적 승인 필요)
- **Related Roadmap**: Database
- **Related Backlog**: 신규
- **Expected Files**: reset_test_data.sql(경고주석만), reset_class_products.sql(경고주석만), add_membership_rules.sql(경고주석만)
- **Out of Scope**: 스크립트 실제 로직 변경, 운영 실행
- **Implementation Notes**: 3개 파일 동일 경고 형식 통일(주석 추가만, 로직 변경 없음).
- **Definition of Done**:
  - [ ] 3개 파일 동일 형식 경고 주석 적용
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(문서/주석 Task)

### `PERF-001` lib/sales.ts:348 .limit(300) 하드코딩 수정(정합성 버그)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PERF-001 (구 D1) | lib/sales.ts:348 .limit(300) 하드코딩 수정(정합성 버그) | Performance & Scale Readiness | Phase 3 | P0 | Medium | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Analytics Feature
- **Related Roadmap**: Analytics
- **Related Backlog**: 신규(CTO Audit 발견)
- **Expected Files**: lib/sales.ts
- **Out of Scope**: 매출 화면 UI 재설계, 결제 로직 변경
- **Implementation Notes**: 300건 초과 시 매출 누락 위험 — 데이터 정합성 이슈로 성능보다 우선순위 높음.
- **Definition of Done**:
  - [ ] 300건 초과 데이터도 정확히 집계됨을 테스트로 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 대량 더미데이터로 집계 정확성 검증

### `PERF-002` fetchMembers() pagination 도입

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PERF-002 (구 D2) | fetchMembers() pagination 도입 | Performance & Scale Readiness | Phase 3 | P0 | Medium | 12h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Performance Feature
- **Related Roadmap**: Performance
- **Related Backlog**: 신규(CTO Audit 발견)
- **Expected Files**: lib/members.ts, app/manager/members/page.tsx
- **Out of Scope**: 회원 목록 UI 리디자인, 검색 로직 변경
- **Implementation Notes**: 현재 center_members 무제한 조회 후 2차 .in() 쿼리 구조 — server-side .range() 적용 필요.
- **Definition of Done**:
  - [ ] 대량회원(1만+) 시뮬레이션에서 응답시간 개선 확인
  - [ ] 기존 필터링 기능 회귀 없음
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 대량 fixture로 부하 테스트

### `PERF-003` reservations/payments/memberships FK 인덱스 추가

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PERF-003 (구 D3) | reservations/payments/memberships FK 인덱스 추가 | Performance & Scale Readiness | Phase 3 | P1 | Medium | 6h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Performance
- **Related Backlog**: E12-F1-T1
- **Expected Files**: add_core_table_indexes.sql(신규)
- **Out of Scope**: 복합 인덱스 최적화(운영 쿼리 패턴 분석 후 별도)
- **Implementation Notes**: reservations.profile_id/membership_id, payments 4개 FK, memberships 4개 FK.
- **Definition of Done**:
  - [ ] EXPLAIN으로 인덱스 사용 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] EXPLAIN ANALYZE 결과 첨부

### `PERF-004` admin_action_logs/orders/notifications FK 인덱스 추가

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PERF-004 (구 D4) | admin_action_logs/orders/notifications FK 인덱스 추가 | Performance & Scale Readiness | Phase 3 | P1 | Low | 6h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Performance
- **Related Backlog**: E12-F1-T2
- **Expected Files**: add_core_table_indexes.sql(PERF-003과 통합 가능)
- **Out of Scope**: (별도 없음)
- **Implementation Notes**: admin_action_logs 5개 FK, orders 3개 FK, notifications.center_id.
- **Definition of Done**:
  - [ ] EXPLAIN으로 인덱스 사용 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] EXPLAIN ANALYZE 결과 첨부

### `PERF-005` RPC 호출 rate limit 도입 검토

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PERF-005 (구 D5) | RPC 호출 rate limit 도입 검토 | Performance & Scale Readiness | Phase 3 | P1 | Medium | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 05_Security.md §6
- **Related Roadmap**: Security
- **Related Backlog**: 신규(CTO Audit 발견)
- **Expected Files**: (설계 문서 산출물, 코드변경 없음)
- **Out of Scope**: 실제 구현(설계 완료 후 별도 Issue)
- **Implementation Notes**: 예약/리뷰 등 스팸 방지, Supabase Edge Function 또는 DB레벨 제한 방식 조사.
- **Definition of Done**:
  - [ ] 방식 설계문서 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(Spike)

### `PERF-006` app/purchases, app/manager/orders 조회 상한 확인

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PERF-006 (구 D6) | app/purchases, app/manager/orders 조회 상한 확인 | Performance & Scale Readiness | Phase 3 | P2 | Low | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Order
- **Related Backlog**: 신규(CTO Audit 발견)
- **Expected Files**: lib/orders.ts, app/purchases/page.tsx, app/manager/orders/page.tsx
- **Out of Scope**: UI 변경
- **Implementation Notes**: 이전 감사에서 미확인(❓)이었던 두 화면의 limit 여부 확인, 필요시 추가.
- **Definition of Done**:
  - [ ] limit 존재여부 확인 및 필요시 추가
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 대량 데이터 시뮬레이션

### `PAY-001` Payment Provider 인터페이스 정리

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PAY-001 (구 E1) | Payment Provider 인터페이스 정리 | Payment & Financial Integrity | Phase 5 | P1 | Low | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Payment Feature
- **Related Roadmap**: Payment
- **Related Backlog**: E06-F1-T1
- **Expected Files**: lib/payments/types.ts, lib/payments/PaymentProviderFactory.ts
- **Out of Scope**: 실제 Toss/PortOne 구현체 작성
- **Implementation Notes**: 기존 인터페이스 재검토, Mock 호환성 확인.
- **Definition of Done**:
  - [ ] 인터페이스 정리안 문서화
  - [ ] 기존 Mock 결제 흐름 회귀 없음
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] npm run test:all

### `PAY-002` Mock/Production Provider 분리

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PAY-002 (구 E2) | Mock/Production Provider 분리 | Payment & Financial Integrity | Phase 5 | P1 | Medium | 6h | Todo |

- **Blocked By**: PAY-001
- **Related Master Spec**: 12_Roadmap.md Payment Feature
- **Related Roadmap**: Payment
- **Related Backlog**: E06-F1-T2
- **Expected Files**: lib/payments/PaymentProviderFactory.ts
- **Out of Scope**: 실제 PG 연동
- **Implementation Notes**: 운영환경에서 Mock 오선택 불가 보장.
- **Definition of Done**:
  - [ ] 환경변수 조합별 Factory 선택 결과 단위테스트 통과
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 운영환경 시뮬레이션 테스트

### `PAY-003` Toss 웹훅 설계(서명검증 포함)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PAY-003 (구 E3) | Toss 웹훅 설계(서명검증 포함) | Payment & Financial Integrity | Phase 5 | P1 | Medium | 8h | Todo |

- **Blocked By**: PAY-001
- **Related Master Spec**: 12_Roadmap.md Payment Feature, 05_Security.md
- **Related Roadmap**: Payment
- **Related Backlog**: E06-F1-T3
- **Expected Files**: (설계문서 산출물, 코드변경 없음)
- **Out of Scope**: 실제 웹훅 엔드포인트 구현
- **Implementation Notes**: 엔드포인트/서명검증/멱등성 설계.
- **Definition of Done**:
  - [ ] 웹훅 설계문서 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(설계 Task)

### `PAY-004` 결제 상태 모델 검토

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PAY-004 (구 E4) | 결제 상태 모델 검토 | Payment & Financial Integrity | Phase 5 | P1 | Low | 6h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Order/Payment/Refund Feature
- **Related Roadmap**: Order
- **Related Backlog**: E06-F1-T4
- **Expected Files**: lib/orders.ts, lib/payments
- **Out of Scope**: 실제 상태전이 로직 변경
- **Implementation Notes**: orders.status/payments 상태값 전수 확인, 실PG 요구 신규상태 식별.
- **Definition of Done**:
  - [ ] Gap 문서 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(검토 Task)

### `PAY-005` 실 PG 연동 준비 체크리스트

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PAY-005 (구 E5) | 실 PG 연동 준비 체크리스트 | Payment & Financial Integrity | Phase 5 | P1 | Low | 3h | Todo |

- **Blocked By**: PAY-003, PAY-004
- **Related Master Spec**: 12_Roadmap.md Payment Feature(Blocked By: PG 공급자)
- **Related Roadmap**: Payment
- **Related Backlog**: E06-F1-T5
- **Expected Files**: (신규 체크리스트 문서)
- **Out of Scope**: 실제 연동 착수
- **Implementation Notes**: 사업자등록/가맹점심사/웹훅URL/키전환/모니터링 체크리스트.
- **Definition of Done**:
  - [ ] 체크리스트 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(문서화 Task)

### `PAY-006` [Blocked] TossPaymentProvider 실제 연동

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PAY-006 (구 E6) | [Blocked] TossPaymentProvider 실제 연동 | Payment & Financial Integrity | Phase 5 | Blocked | Critical | 24h | Todo |

- **Blocked By**: PAY-001~005 완료 + 사업자등록 완료 + 사용자 승인
- **Related Master Spec**: 12_Roadmap.md Payment Feature(Blocked By: PG 공급자, 가맹점 계약)
- **Related Roadmap**: Payment
- **Related Backlog**: E06-F1-T6
- **Expected Files**: lib/payments/TossPaymentProvider.ts, lib/payments/PaymentProviderFactory.ts
- **Out of Scope**: PortOne 구현(별도 Issue), 프론트 결제위젯 UI 변경
- **Implementation Notes**: **Risk Critical + Blocked — 사업자등록 완료 및 명시적 승인 전 착수 금지.**
- **Definition of Done**:
  - [ ] 실제 Toss 승인요청 성공/실패 정확 처리
  - [ ] fulfill_order() 정확히 1회 호출
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] Toss 테스트키 성공/실패/취소 시나리오 검증
  - [ ] 별도 Security Review 필수

### `PAY-007` point_transactions/point_accounts/point_logs 분석(통합 아님)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PAY-007 (구 E7) | point_transactions/point_accounts/point_logs 분석(통합 아님) | Payment & Financial Integrity | Phase 6 | P1 | Medium | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Analytics Feature
- **Related Roadmap**: Analytics
- **Related Backlog**: E04-F3-T1
- **Expected Files**: lib/sales.ts, lib/reviews.ts
- **Out of Scope**: 실제 원장 통합/마이그레이션(통합여부는 별도 Decision)
- **Implementation Notes**: 역할/데이터흐름/중복/참조코드/RPC 분석까지만 수행.
- **Definition of Done**:
  - [ ] 분석문서 완성
  - [ ] 통합여부는 별도 Decision Log에만 기록, 이 Issue에서 결정하지 않음
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(분석 Task)

### `PAY-008` 미발급 주문 회원 셀프 취소 기능

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PAY-008 (구 E8) | 미발급 주문 회원 셀프 취소 기능 | Payment & Financial Integrity | Phase 6 | P2 | Low | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Order Feature
- **Related Roadmap**: Order
- **Related Backlog**: E06-F2-T1
- **Expected Files**: lib/orders.ts, app/purchases/page.tsx
- **Out of Scope**: 발급완료 주문 환불(기존 refund_membership 사용)
- **Implementation Notes**: pending 상태에서만 취소 가능.
- **Definition of Done**:
  - [ ] pending 상태 취소버튼 노출/작동
  - [ ] 발급완료 주문엔 미노출
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 상태별 취소가능여부 테스트

### `PAY-009` 센터별 환불정책(기간/조건) 설정 기능

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| PAY-009 (구 E9) | 센터별 환불정책(기간/조건) 설정 기능 | Payment & Financial Integrity | Phase 6 | P2 | Medium | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Refund Feature
- **Related Roadmap**: Refund
- **Related Backlog**: E06-F2-T2
- **Expected Files**: lib/settings.ts, app/manager/settings/page.tsx
- **Out of Scope**: 실PG 환불 API 연동
- **Implementation Notes**: 현재 24시간/미사용 조건 하드코딩 → 센터별 설정화.
- **Definition of Done**:
  - [ ] 설정값 변경이 실제 환불판정에 반영
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 기본값/변경값 각각 환불판정 테스트

### `CRM-001` app/manager/staff/page.tsx 초대방식 확인(Spike)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| CRM-001 (구 F1) | app/manager/staff/page.tsx 초대방식 확인(Spike) | Admin, Staff & CRM | Phase 1 | P1 | Low | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: platform-spec/epics/EPIC_01_Admin_System.md(초대 흐름)
- **Related Roadmap**: Role System
- **Related Backlog**: 신규(platform-spec Gap)
- **Expected Files**: app/manager/staff/page.tsx(읽기전용 분석)
- **Out of Scope**: 실제 초대 기능 구현
- **Implementation Notes**: 현재 직원추가 방식(초대 vs 직접지정) 문서화, spec과의 Gap 결론.
- **Definition of Done**:
  - [ ] 현재 방식 문서화 및 Gap 결론 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(Spike)

### `CRM-002` Staff Mode/Admin System 역할 경계 정의

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| CRM-002 (구 F2) | Staff Mode/Admin System 역할 경계 정의 | Admin, Staff & CRM | Phase 1 | P2 | Low | 6h | Todo |

- **Blocked By**: CRM-001
- **Related Master Spec**: platform-spec/epics/EPIC_01_Admin_System.md
- **Related Roadmap**: Role System
- **Related Backlog**: 신규(platform-spec Gap)
- **Expected Files**: app/manager/*(읽기전용 분석)
- **Out of Scope**: 실제 UI 분리 구현(결정 후 별도 Issue)
- **Implementation Notes**: 현재 별도 UX 없이 Admin System 부분집합임을 재확인, 분리 필요여부 제품결정 자료 정리.
- **Definition of Done**:
  - [ ] 역할경계 자료 정리 완성
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(Spike)

### `CRM-003` 담당회원 배정 코드/DB 영향분석

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| CRM-003 (구 F3) | 담당회원 배정 코드/DB 영향분석 | Admin, Staff & CRM | Phase 6 | P2 | Low | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md CRM Feature
- **Related Roadmap**: CRM
- **Related Backlog**: E03-F2-T1
- **Expected Files**: app/manager/members/page.tsx(읽기전용), lib/members.ts(읽기전용)
- **Out of Scope**: 신규 테이블 실제 생성(CRM-004에서, 승인 후)
- **Implementation Notes**: 별도 조인테이블 설계안 문서화(우선안 기록만).
- **Definition of Done**:
  - [ ] 설계안(컬럼/FK/RLS 초안) 문서화
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(분석 Task)

### `CRM-004` [Blocked] 담당 관계 조인테이블 생성 및 배정 UI

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| CRM-004 (구 F4) | [Blocked] 담당 관계 조인테이블 생성 및 배정 UI | Admin, Staff & CRM | Phase 6 | Blocked | Medium | 16h | Todo |

- **Blocked By**: CRM-003 + 사용자 승인(신규 테이블 생성)
- **Related Master Spec**: 12_Roadmap.md CRM Feature
- **Related Roadmap**: CRM
- **Related Backlog**: E03-F2-T2
- **Expected Files**: app/manager/members/page.tsx, lib/members.ts
- **Out of Scope**: 상담고객(leads) 관리(CRM-005에서 별도)
- **Implementation Notes**: 승인 전까지 신규 테이블 생성 금지.
- **Definition of Done**:
  - [ ] 담당배정/조회 기능 동작
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 배정 후 새로고침 유지 확인

### `CRM-005` 상담고객(leads) CRUD 화면

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| CRM-005 (구 F5) | 상담고객(leads) CRUD 화면 | Admin, Staff & CRM | Phase 6 | P2 | Medium | 12h | Todo |

- **Blocked By**: SEC-007, SEC-008(leads가 RLS 미적용 테이블 — 정비 후 착수 권장)
- **Related Master Spec**: 12_Roadmap.md CRM Feature
- **Related Roadmap**: CRM
- **Related Backlog**: E03-F2-T4(유사)
- **Expected Files**: app/manager/members/page.tsx, lib/members.ts(또는 신규 lib/leads.ts)
- **Out of Scope**: 담당회원 배정(CRM-003/004)
- **Implementation Notes**: leads 테이블은 RLS 미적용 목록에 포함되어 있어 보안정비(SEC-007/008) 완료 후 착수 권장.
- **Definition of Done**:
  - [ ] 상담고객 등록/조회/상태변경 동작
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 신규 등록 후 목록 반영 확인

### `NOTIF-001` notify_upcoming_reservations/notify_expiring_passes 스케줄러 연결

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| NOTIF-001 (구 G1) | notify_upcoming_reservations/notify_expiring_passes 스케줄러 연결 | Notification & Automation | Phase 6 | P1 | Low | 6h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Notification Feature(Blocked By: Realtime/pg_cron 운영설정)
- **Related Roadmap**: Notification
- **Related Backlog**: E08-F2-T1
- **Expected Files**: (pg_cron 등록, SQL 변경 없음 — 운영 설정)
- **Out of Scope**: 함수 로직 자체 변경
- **Implementation Notes**: pg_cron 등록 후 실제 알림 생성 확인.
- **Definition of Done**:
  - [ ] 스케줄러 실행 후 notifications 테이블 신규행 생성 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 운영 등록 후 실제 발생 확인

### `NOTIF-002` 알림 설정-실제 발송 채널(FCM/알림톡) 연결

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| NOTIF-002 (구 G2) | 알림 설정-실제 발송 채널(FCM/알림톡) 연결 | Notification & Automation | Phase 6 | P2 | Medium | 16h | Todo |

- **Blocked By**: NOTIF-001
- **Related Master Spec**: 12_Roadmap.md Notification Feature(Blocked By: 메시지 공급자)
- **Related Roadmap**: Notification
- **Related Backlog**: E08-F3-T1
- **Expected Files**: app/settings/notifications/page.tsx, lib/notifications.ts
- **Out of Scope**: 인앱 알림(이미 구현됨) 변경
- **Implementation Notes**: 설정 on/off에 따라 실제 발송 여부 확인.
- **Definition of Done**:
  - [ ] 설정에 따른 실제 발송 채널 동작 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 테스트 발송 채널로 검증

### `ARCH-001` /manager 중첩 레이아웃 도입(ManagerNav 20회 중복 제거)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ARCH-001 (구 H1) | /manager 중첩 레이아웃 도입(ManagerNav 20회 중복 제거) | Architecture & Code Quality | Phase 3 | P2 | Low | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Architecture Feature
- **Related Roadmap**: Architecture
- **Related Backlog**: 신규(CTO Audit 발견)
- **Expected Files**: app/manager/layout.tsx(신규), app/manager/*/page.tsx(20개, import 제거)
- **Out of Scope**: ManagerNav 자체 디자인 변경, 권한 로직 변경
- **Implementation Notes**: 20개 파일 개별 import 제거, 레이아웃 레벨로 이동.
- **Definition of Done**:
  - [ ] 중복 제거 후 전 매니저 화면 회귀 없음
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 19개 매니저 라우트 전수 수동 확인

### `ARCH-002` 회원 라우트 레이아웃(BottomNav 17회 중복 제거)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ARCH-002 (구 H2) | 회원 라우트 레이아웃(BottomNav 17회 중복 제거) | Architecture & Code Quality | Phase 3 | P2 | Low | 6h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Architecture Feature
- **Related Roadmap**: Architecture
- **Related Backlog**: 신규(CTO Audit 발견)
- **Expected Files**: app/(member)/layout.tsx 또는 유사(신규), app/*/page.tsx(17개)
- **Out of Scope**: BottomNav 디자인 변경
- **Implementation Notes**: ARCH-001과 동일 패턴.
- **Definition of Done**:
  - [ ] 중복 제거 후 회원 화면 회귀 없음
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 회원 라우트 전수 수동 확인

### `ARCH-003` app/manager/classes/page.tsx(1628줄) 1차 분할

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ARCH-003 (구 H3) | app/manager/classes/page.tsx(1628줄) 1차 분할 | Architecture & Code Quality | Phase 3 | P2 | Medium | 16h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Architecture Feature
- **Related Roadmap**: Architecture
- **Related Backlog**: 신규(System 항목)
- **Expected Files**: app/manager/classes/page.tsx, app/manager/classes/*(신규 서브컴포넌트)
- **Out of Scope**: 기능 변경(리팩토링만), 직접배치/무료배치 로직 변경
- **Implementation Notes**: 캘린더/배치/CRUD 서브컴포넌트 분리.
- **Definition of Done**:
  - [ ] 기능 회귀 없음
  - [ ] 파일 라인수 유의미하게 감소
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 관리자 직접배치/무료배치/일반예약 전체 시나리오 회귀 테스트

### `ARCH-004` Supabase 타입 자동생성 도입

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ARCH-004 (구 H4) | Supabase 타입 자동생성 도입 | Architecture & Code Quality | Phase 2 | P2 | Low | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Roadmap.md Stack Gap('generated DB types 부족')
- **Related Roadmap**: Database
- **Related Backlog**: E11-F3-T1
- **Expected Files**: package.json, lib/supabaseClient.ts
- **Out of Scope**: 기존 361건 any 일괄 제거(H5에서 점진적으로)
- **Implementation Notes**: supabase gen types typescript 스크립트 추가.
- **Definition of Done**:
  - [ ] 타입 생성 스크립트 동작
  - [ ] 빌드 통과
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] npm run build

### `ARCH-005` any 최다 3개 파일(members/orders/classes) 타입 개선

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ARCH-005 (구 H5) | any 최다 3개 파일(members/orders/classes) 타입 개선 | Architecture & Code Quality | Phase 2 | P3 | Low | 16h | Todo |

- **Blocked By**: ARCH-004
- **Related Master Spec**: 14_Coding_Convention.md
- **Related Roadmap**: Database
- **Related Backlog**: E11-F3-T2
- **Expected Files**: lib/members.ts, lib/orders.ts, lib/classes.ts
- **Out of Scope**: 나머지 파일 any 제거(향후 별도 Issue)
- **Implementation Notes**: 생성된 타입으로 any 캐스팅 대체.
- **Definition of Done**:
  - [ ] 세 파일 any 대부분 제거
  - [ ] 빌드 통과
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] npm run build

### `ARCH-006` eslint.config.js 신설

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ARCH-006 (구 H6) | eslint.config.js 신설 | Architecture & Code Quality | Phase 3 | P2 | Low | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 14_Coding_Convention.md
- **Related Roadmap**: CI/CD
- **Related Backlog**: E11-F4-T1
- **Expected Files**: eslint.config.js(신규)
- **Out of Scope**: 기존 코드 전체 lint 위반 수정
- **Implementation Notes**: Next.js 16+TS 기준 설정.
- **Definition of Done**:
  - [ ] npm run lint 정상 실행
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] npm run lint

### `ARCH-007` Tailwind 실제 적용 확인/연결

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ARCH-007 (구 H7) | Tailwind 실제 적용 확인/연결 | Architecture & Code Quality | Phase 3 | P2 | Low | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 13_Design_System.md
- **Related Roadmap**: Architecture
- **Related Backlog**: E11-F4-T2
- **Expected Files**: app/globals.css
- **Out of Scope**: Tailwind로 전면 스타일 전환
- **Implementation Notes**: @import 누락 확인 후 필요시 추가.
- **Definition of Done**:
  - [ ] 유틸리티 클래스 실제 반영 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 빌드 후 브라우저 확인

### `ARCH-008` .env.local.example 신설

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ARCH-008 (구 H8) | .env.local.example 신설 | Architecture & Code Quality | Phase 0 | P3 | Low | 2h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 12_Deployment.md
- **Related Roadmap**: CI/CD
- **Related Backlog**: E11-F4-T3
- **Expected Files**: .env.local.example(신규)
- **Out of Scope**: (별도 없음)
- **Implementation Notes**: 필요 환경변수 이름만, 비밀값 없음.
- **Definition of Done**:
  - [ ] 파일 존재, 비밀값 없음 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 파일 내용 리뷰

### `ARCH-009` MapPreview Leaflet CDN에 SRI 적용 검토

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| ARCH-009 (구 H9) | MapPreview Leaflet CDN에 SRI 적용 검토 | Architecture & Code Quality | Phase 3 | P3 | Low | 3h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 05_Security.md §6(의존성 스캔)
- **Related Roadmap**: Security
- **Related Backlog**: 신규(CTO Audit 발견)
- **Expected Files**: app/components/MapPreview.tsx
- **Out of Scope**: 지도 기능 자체 변경
- **Implementation Notes**: SRI 해시 적용 또는 로컬 번들링 결정.
- **Definition of Done**:
  - [ ] 결정사항 적용 또는 문서화
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 지도 렌더 정상 동작 확인

### `LEGACY-001` product_passes 삭제후보 확정

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| LEGACY-001 (구 I1) | product_passes 삭제후보 확정 | Legacy & Dead Code Cleanup | Phase 2 | P2 | Low | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Database
- **Related Backlog**: E04-F3-T2
- **Expected Files**: (조사, 코드변경 없음)
- **Out of Scope**: 테이블 DROP(별도 승인)
- **Implementation Notes**: 사용처/FK/RPC 조사 후 결론.
- **Definition of Done**:
  - [ ] 결론 문서화
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `LEGACY-002` reviews 삭제후보 확정

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| LEGACY-002 (구 I2) | reviews 삭제후보 확정 | Legacy & Dead Code Cleanup | Phase 2 | P2 | Low | 4h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Database
- **Related Backlog**: 신규(Community 항목)
- **Expected Files**: lib/reviews.ts(읽기전용)
- **Out of Scope**: 테이블 DROP
- **Implementation Notes**: center_reviews 대비 사용여부 확인.
- **Definition of Done**:
  - [ ] 결론 문서화
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `LEGACY-003` 5종 레거시 테이블 최종 확정(change_logs 포함)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| LEGACY-003 (구 I3) | 5종 레거시 테이블 최종 확정(change_logs 포함) | Legacy & Dead Code Cleanup | Phase 2 | P2 | Low | 6h | Todo |

- **Blocked By**: LEGACY-001, LEGACY-002, ACL-004
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Database
- **Related Backlog**: 신규(System 항목)
- **Expected Files**: (조사, 코드변경 없음)
- **Out of Scope**: 실제 DROP(별도 승인)
- **Implementation Notes**: product_passes/point_logs/change_logs/chat_messages/reviews 종합.
- **Definition of Done**:
  - [ ] 5종 종합 결론 문서화
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `LEGACY-004` 미사용 추정 23개 테이블 재확인

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| LEGACY-004 (구 I4) | 미사용 추정 23개 테이블 재확인 | Legacy & Dead Code Cleanup | Phase 2 | P3 | Low | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 02_Database.md
- **Related Roadmap**: Database
- **Related Backlog**: 신규
- **Expected Files**: (조사, 코드변경 없음)
- **Out of Scope**: 테이블 DROP
- **Implementation Notes**: 사용여부 최종 결론.
- **Definition of Done**:
  - [ ] 23개 테이블 사용여부 결론
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(조사 Task)

### `DOC-001` platform-spec 실제 코드기준 개정

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DOC-001 (구 J1) | platform-spec 실제 코드기준 개정 | Documentation & Spec Reconciliation | Phase 0 | P0 | Low | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 00_Project_Principles.md
- **Related Roadmap**: Architecture(문서 정합성)
- **Related Backlog**: 신규(platform-spec Gap EPIC 21)
- **Expected Files**: ※ Execution Plan 범위 밖 — 실제 수정은 Master Spec 담당 트랙에서 진행
- **Out of Scope**: Execution Plan 작업자가 platform-spec 직접 수정(금지, Master Spec 트랙 소관)
- **Implementation Notes**: **중요 업데이트(2026-07-31 확인)**: 이 Issue가 요구하던 개정 작업이 이미 별도 트랙에서 상당부분 진행된 것으로 보임 — `docs/platform-spec/`가 v1.1로 갱신되어 실제 코드 기준(Supabase/Next.js/RLS) Current State가 반영됨, `11_Terminology_Map.md`·`12_Roadmap.md`·`13_Implementation_Roadmap.md`·`14_Backlog_Guide.md`가 신규 추가됨(현재 uncommitted 상태 확인). **착수 전 최신 platform-spec을 먼저 검토해 잔여 작업 범위를 재확인할 것.**
- **Definition of Done**:
  - [ ] 잔여 Gap 유무 확인 후 필요시에만 후속 작업 범위 재정의
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(검증 Task)

### `DOC-002` 용어 충돌 매핑표 작성(memberships 등)

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DOC-002 (구 J2) | 용어 충돌 매핑표 작성(memberships 등) | Documentation & Spec Reconciliation | Phase 0 | P0 | Low | 3h | Todo |

- **Blocked By**: DOC-001
- **Related Master Spec**: 02_Database.md, docs/18_ERD.md
- **Related Roadmap**: Architecture(문서 정합성)
- **Related Backlog**: 신규
- **Expected Files**: ※ 실제 수정은 Master Spec 담당 트랙 소관
- **Out of Scope**: Execution Plan 작업자가 직접 매핑표 파일 수정
- **Implementation Notes**: **중요 업데이트**: `docs/platform-spec/11_Terminology_Map.md`가 이미 존재하며 memberships 충돌을 포함한 Canonical Mapping 표를 제공함(확인됨, 61줄). **이 Issue는 사실상 완료 상태로 추정 — 착수 전 기존 문서와 `docs/18_ERD.md` 간 정합성만 재확인.**
- **Definition of Done**:
  - [ ] 기존 Terminology Map과 docs/18_ERD.md 간 불일치 여부 확인
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(검증 Task)

### `DOC-003` Decision Log에 스펙-코드 괴리 처리방침 ADR 추가

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DOC-003 (구 J3) | Decision Log에 스펙-코드 괴리 처리방침 ADR 추가 | Documentation & Spec Reconciliation | Phase 0 | P1 | Low | 2h | Todo |

- **Blocked By**: DOC-001
- **Related Master Spec**: 08_Decision_Log.md
- **Related Roadmap**: Architecture(문서 정합성)
- **Related Backlog**: 신규
- **Expected Files**: ※ 실제 수정은 Master Spec 담당 트랙 소관
- **Out of Scope**: Execution Plan 작업자가 Decision Log 직접 수정
- **Implementation Notes**: 08_Decision_Log.md에 이미 ADR-001~011 및 미확정항목 표가 존재(확인됨). 신규 ADR 필요여부만 재확인.
- **Definition of Done**:
  - [ ] 신규 ADR 필요여부 결론
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음(검증 Task)

### `TEST-001` 용량초과(capacity-override) 2단계 통합테스트

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| TEST-001 (구 K2) | 용량초과(capacity-override) 2단계 통합테스트 | Testing & CI Hardening | Phase 4 | P2 | Low | 6h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 06_Testing.md
- **Related Roadmap**: Reservation
- **Related Backlog**: E05-F2-T1
- **Expected Files**: tests/integration/admin-assignment-security.test.ts
- **Out of Scope**: 플로우 로직 자체 변경
- **Implementation Notes**: 확인→확정 2단계 케이스 추가.
- **Definition of Done**:
  - [ ] 신규 테스트 케이스 통과
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] npm run test:integration

### `TEST-002` 단위테스트 Supabase 클라이언트 초기화 결합 제거

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| TEST-002 (구 K3) | 단위테스트 Supabase 클라이언트 초기화 결합 제거 | Testing & CI Hardening | Phase 2 | P3 | Low | 8h | Todo |

- **Blocked By**: 없음
- **Related Master Spec**: 06_Testing.md, 12_Deployment.md
- **Related Roadmap**: CI/CD
- **Related Backlog**: 신규(Infra 항목)
- **Expected Files**: lib/supabaseClient.ts, vitest.config.ts
- **Out of Scope**: 통합 테스트 구조 변경
- **Implementation Notes**: Node 20 통과 확인.
- **Definition of Done**:
  - [ ] Node 20 환경에서 npm run test 통과
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] Node 20 CI 시뮬레이션

### `DEFER-001` 커뮤니티 게시판 MVP

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DEFER-001 (구 L1) | 커뮤니티 게시판 MVP | Deferred | Phase 7 | P3 | Low | 0h | Todo |

- **Blocked By**: 제품 로드맵 결정
- **Related Master Spec**: 12_Roadmap.md Marketing 유사
- **Related Roadmap**: Marketing(유사영역)
- **Related Backlog**: E10-F2
- **Expected Files**: (해당 없음)
- **Out of Scope**: 착수 자체가 제품결정 전까지 보류
- **Implementation Notes**: Sprint 미배정, 착수 안 함.
- **Definition of Done**:
  - [ ] 해당 없음(대기)
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음

### `DEFER-002` Naver 로그인

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DEFER-002 (구 L2) | Naver 로그인 | Deferred | Phase 1(연동시) | P3 | Low | 0h | Todo |

- **Blocked By**: 제품 로드맵 결정
- **Related Master Spec**: 12_Roadmap.md Authentication
- **Related Roadmap**: Authentication
- **Related Backlog**: 신규
- **Expected Files**: (해당 없음)
- **Out of Scope**: 착수 보류
- **Implementation Notes**: Sprint 미배정.
- **Definition of Done**:
  - [ ] 해당 없음(대기)
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음

### `DEFER-003` 수강권 양도

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DEFER-003 (구 L3) | 수강권 양도 | Deferred | Phase 4(연동시) | P3 | Low | 0h | Todo |

- **Blocked By**: 제품 로드맵 결정
- **Related Master Spec**: 12_Roadmap.md Membership (Pass)
- **Related Roadmap**: Membership (Pass)
- **Related Backlog**: 신규
- **Expected Files**: (해당 없음)
- **Out of Scope**: 착수 보류
- **Implementation Notes**: Sprint 미배정.
- **Definition of Done**:
  - [ ] 해당 없음(대기)
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음

### `DEFER-004` 직원 급여/근무스케줄

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DEFER-004 (구 L4) | 직원 급여/근무스케줄 | Deferred | Phase 6(연동시) | P3 | Low | 0h | Todo |

- **Blocked By**: 제품 로드맵 결정
- **Related Master Spec**: 12_Roadmap.md CRM 유사
- **Related Roadmap**: CRM(유사영역)
- **Related Backlog**: 신규
- **Expected Files**: (해당 없음)
- **Out of Scope**: 착수 보류
- **Implementation Notes**: Sprint 미배정.
- **Definition of Done**:
  - [ ] 해당 없음(대기)
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음

### `DEFER-005` Marketing/Platform SaaS/Developer Platform 전체

| Issue ID | Title | Epic | Milestone (Phase) | Priority | Risk | Estimated Time | Status |
|---|---|---|---|---|---|---|---|
| DEFER-005 (구 L5) | Marketing/Platform SaaS/Developer Platform 전체 | Deferred | Phase 7 | P3 | Low | 0h | Todo |

- **Blocked By**: 제품 로드맵 확인
- **Related Master Spec**: 12_Roadmap.md Marketing/Platform SaaS/Developer Platform
- **Related Roadmap**: Marketing, Platform SaaS, Developer Platform
- **Related Backlog**: 신규
- **Expected Files**: (해당 없음)
- **Out of Scope**: 전체 착수 보류
- **Implementation Notes**: 제품 로드맵 확인 전까지 Issue 생성 자체를 보류.
- **Definition of Done**:
  - [ ] 해당 없음(대기)
- **Verification Checklist**:
  - [ ] TypeScript Build 통과
  - [ ] Lint 통과
  - [ ] 기존 기능 회귀 없음
  - [ ] 모바일 동작 확인
  - [ ] 관련 테스트 통과
  - [ ] 해당 없음

## 3. 요약 통계

- 총 Issue 수: **70개** (v1: 70개 항목 표기와 동일 — 활성 65 + Deferred 5)
- Priority 분포: P0 24 / P1 17 / P2 17 / P3 10 / Blocked 2
- 총 예상시간: 약 466h (v1: 약 469h와 동일 수준 — Deferred 5개는 0h로 집계되어 미세 차이)

## 4. Execution Rules

1. Issue는 반드시 **Master Spec → Roadmap → Backlog → Execution Plan** 순으로 생성한다.
2. Priority보다 **Dependency(Blocked By)**를 우선한다 — 선행 작업이 끝나지 않으면 Priority가 높아도 착수하지 않는다.
3. Risk가 **Critical**인 작업은 반드시 별도 Review를 거친다(담당자 1인 승인만으로 진행하지 않음).
4. Verification Checklist가 완료되지 않으면 **Done**으로 변경하지 않는다.
5. **Released**는 실제 배포 이후에만 사용한다.
6. Execution Plan은 제품 요구사항을 변경하지 않는다.
7. Execution Plan은 Master Spec의 SSOT를 절대 변경하지 않는다.
