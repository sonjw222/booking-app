# Booking App Master Specification

# 08. Decision Log

Version : 1.0

---

# 목적

Decision Log는 프로젝트에서 내린 중요한 설계 결정과 그 이유를 기록하는 문서이다.

모든 주요 아키텍처 변경과 기술 선택은 반드시 기록한다.

---

# 작성 원칙

다음 항목을 반드시 포함한다.

Decision ID

Date

Author

Status

Category

Decision

Reason

Alternatives

Impact

Related Documents

---

# Status

Proposed

Accepted

Deprecated

Rejected

Superseded

---

# 결정 기록

## DEC-001. 프라이빗 수업 — 공개 예약형 vs 지정회원 전용형

- **Date**: 2026-08-03
- **Author**: Claude (QA 후속 배치, feature/qa-batch-nav-reservation-notifications)
- **Status**: Proposed
- **Category**: 예약 구조
- **Decision**: 아직 결정 안 됨 — 현재 MVP는 "공개 예약형"으로 동작 중(누구나 회원 앱에서
  볼 수 있고 선착순 1명이 예약, `capacity=1` CHECK로 서버 강제). 지정회원 전용형(관리자가
  사전에 특정 회원만 예약 가능하도록 지정)은 구현 여부 미정.
- **Reason**: 사용자가 이번 배치에서 "지정 회원 전용 정책"을 임의 구현 금지 항목으로 명시함
  — 프라이빗 수업의 실제 운영 방식(트레이너 1:1 수업을 아무나 선착순으로 예약하게 둘지,
  관리자가 회원과 사전 협의 후 배정하는 형태로만 쓸지)이 제품 정책에 달려 있음.
- **Alternatives**:
  - A) 현행 유지(공개 예약형만) — 추가 스키마 불필요, 이미 동작 중.
  - B) 지정회원 전용형 추가 — `class_allowed_profiles`류 신규 테이블/컬럼 필요, `reserve_class()`에
    "이 회원이 배정 대상인지" 체크 추가, 관리자 UI에 회원 지정 화면 신설.
  - C) 관리자 직접배치(`admin_assign_reservation`)만으로 지정형을 대체(신규 스키마 없이 기존
    기능 재사용) — 프라이빗 수업을 등록할 때 "일반 예약 비공개"(회원 앱 노출 안 함) 옵션만
    추가하고, 실제 배정은 항상 관리자가 직접배치로 처리.
- **Impact**: B는 스키마 변경 + RLS + UI 신설이 필요한 중간 규모 작업. C는 추가 스키마 없이
  거의 바로 구현 가능(수업 목록 조회 쿼리에 "비공개" 필터만 추가).
- **Related Documents**: `docs/TODO.md` P2-17, `add_admin_assignment.sql`

## DEC-002. 프라이빗 수업 슬롯 단위(`private_slot_unit`)·동시예약 제한(`private_max_concurrent_*`)

- **Date**: 2026-08-03
- **Author**: Claude (QA 후속 배치)
- **Status**: Proposed
- **Category**: 예약 구조
- **Decision**: 아직 결정 안 됨 — 이번 배치에서 구현하지 않음(사용자가 "동시 슬롯 예약",
  "반복 슬롯 자동생성"을 임의 구현 금지 항목으로 명시).
- **Reason**: 이 두 설정은 "프라이빗 수업을 30분 단위 슬롯으로 쪼개 여러 트레이너가 동시에
  진행 가능한 슬롯 수를 제한"하는, 지금의 "수업 하나 = 프라이빗 예약 하나(capacity=1)" 모델과
  전혀 다른 스케줄링 시스템을 전제로 함 — 클래스 등록 자체가 슬롯 그리드 UI로 바뀌어야 해
  현재 구조를 확장하는 수준이 아니라 별도 설계가 필요.
- **Alternatives**:
  - A) 현재 모델 유지, 이 두 설정은 UI에서 숨김(운영설정 재감사 결과와 동일 처리).
  - B) 슬롯 기반 프라이빗 예약 시스템 별도 설계·구현(중~대규모 작업, 별도 기획 필요).
- **Impact**: A 선택 시 이번 배치에서 바로 적용 가능(설정 UI 숨김만). B는 별도 스프린트 규모.
- **Related Documents**: `docs/TODO.md` P2-17

## DEC-003. `class_allowed_products`(수업별 허용 수강권) 관리 UI 부재

- **Date**: 2026-08-03
- **Author**: Claude (QA 후속 배치)
- **Status**: **Resolved (2026-08-06, P3 배치)** — Alternative A로 구현됨
- **Category**: 예약 구조
- **Decision**: 아직 결정 안 됨 — `reserve_class()`는 이미 `class_allowed_products`를 읽어
  제한하지만(존재하면 그 상품만 허용, 없으면 무제한), 이 테이블에 값을 넣을 관리자 UI가
  그룹/프라이빗 구분 없이 애초에 존재하지 않음(이번 배치에서 새로 발견 — 프라이빗 전용
  문제가 아니라 기존부터 있던 전체 갭).
- **Reason**: 이번 배치 범위(실브라우저 QA 후속 수정 + 6개 트랙)를 넘어서는 신규 관리자 UI
  구축이 필요해 이번엔 조사만 하고 구현하지 않음.
- **Alternatives**:
  - A) 수업 등록 화면에 상품 다중 선택 UI 추가(기존 `class_allowed_products` 테이블 그대로 재사용,
    신규 스키마 불필요).
  - B) 현행 유지(모든 수업이 사실상 무제한 허용 상태 지속).
- **Impact**: A는 프론트엔드 UI 추가 + `lib/classes.ts` 함수 확장 정도로 스키마 변경 없이 가능한
  중간 크기 작업 — 후속 배치 후보로 적합.
- **Related Documents**: `docs/TODO.md` P2-17, `reservation_functions.sql`(reserve_class 자격 조건)
- **2026-08-06 갱신(P3 배치, feature/auth-private-class-membership)**: DEC-003 작성 시점(2026-08-03)
  이후, 프라이빗 수업 관리자 UI를 추가하던 배치에서 Alternative A가 이미 구현됐음을 이번 P3
  감사로 확인했다 — `app/manager/classes/page.tsx`에 "예약 가능 수강권" 다중 선택 칩(등록/수정/
  반복등록/스케줄 복사 전부 `lib/classes.ts`의 `setClassProducts`/`setClassProductsBulk`로
  연결), 회원 화면(`usable_memberships_for_classes`)도 이미 정확히 반영. 이 배치가 새로 만든
  건 검색 UI, `reserve_with_membership()`의 서버 강제 누락 수정
  (`fix_class_allowed_products_enforcement_draft_proposed.sql`, SQL 승인 대기), 타 센터/goods
  혼입을 막는 INSERT RLS 강화, "구매 가능한 수강권" 추천에 goods가 섞이던 버그 수정뿐이다.
  이 DEC 자체는 "UI가 없다"는 전제가 더 이상 사실이 아니므로 해결 완료로 닫는다.
- **2026-08-07 추가 갱신**: 실브라우저 재검증(사용자 보고 + CI 재현)에서 "모든 수강권 허용"
  수업인데도 회원이 보유한 특정 pass 하나가 목록에서 사라지는 버그를 발견 — 근본 원인은
  `app/manager/classes/page.tsx`의 class_allowed_products 저장 로직이 부수효과로
  `membership_schedule_rules`에도 자동으로 규칙을 추가/삭제하던 것(`autoAddRulesForClass`/
  `removeRulesForClass`, 이번 P3 배치에서 만든 코드)이었다. `membership_schedule_rules`는
  `/manager/membership-rules`(`lib/passes.ts`)에서 관리자가 직접 관리하는 **완전히 독립된
  기존 기능**임을 확인 — 두 기능을 자동으로 연동한 것 자체가 설계 실수였다. 부수효과 코드를
  완전히 제거해 class_allowed_products와 membership_schedule_rules를 다시 독립시켰다(관련
  함수 `autoAddRulesForClass`/`removeRulesForClass`/`fetchAllPassProductIds` 삭제).

---

# Category

Architecture

Database

API

Security

Authentication

Authorization

UI/UX

Performance

Testing

Infrastructure

Business

---

# Decision Template

Decision ID

Date

Author

Category

Status

Decision

Reason

Alternatives

Pros

Cons

Impact

Related Documents

---

# DEC-001

Title

Multi Center Architecture

Status

Accepted

Category

Architecture

Decision

Organization 아래에 여러 Center를 둘 수 있는 구조를 채택한다.

Reason

향후 프랜차이즈 및 다지점 운영을 지원하기 위함.

Alternatives

Center만 사용하는 단일 구조

Impact

Database

API

Permission

Dashboard

모두 Multi Center 기준으로 개발한다.

---

# DEC-002

Title

Role Based Access Control

Status

Accepted

Category

Security

Decision

RBAC(Role Based Access Control)를 사용한다.

Reason

권한을 유연하게 관리하기 위함.

Alternatives

권한을 User에 직접 저장

Impact

Role

Permission

Center Member

RLS

---

# DEC-003

Title

Multiple Login Methods

Status

Accepted

Category

Authentication

Decision

하나의 계정에 여러 로그인 방식을 연결할 수 있다.

지원

Email

Kakao

Apple

Google

Naver

Reason

사용자 편의성 향상

Impact

Account Linking

Session

Security

---

# DEC-004

Title

Apple Hide My Email

Status

Accepted

Category

Security

Decision

Apple Relay Email은 자동 연결하지 않는다.

Reason

잘못된 계정 병합 방지

Impact

Account Linking

---

# DEC-005

Title

Soft Delete

Status

Accepted

Category

Database

Decision

모든 Business Table은 Soft Delete를 사용한다.

Reason

데이터 복구

감사 로그

법적 요구사항 대응

---

# DEC-006

Title

Activity Log

Status

Accepted

Category

Security

Decision

모든 중요 작업은 Activity Log를 남긴다.

---

# DEC-007

Title

Supabase Authentication

Status

Accepted

Category

Authentication

Decision

Supabase Auth를 기본 인증 시스템으로 사용한다.

---

# DEC-008

Title

RLS

Status

Accepted

Category

Security

Decision

모든 Business Table은 RLS를 활성화한다.

---

# DEC-009

Title

API Style

Status

Accepted

Category

API

Decision

REST API 기반으로 구현한다.

---

# DEC-010

Title

Design Philosophy

Status

Accepted

Category

UI/UX

Decision

Apple 수준의 심플함을 목표로 하되 Booking App만의 디자인 시스템을 구축한다.

---

# 변경 절차

새로운 설계 결정이 필요한 경우

Issue 생성

↓

Discussion

↓

Decision 작성

↓

Architecture 업데이트

↓

관련 문서 수정

↓

Claude Rule 업데이트

↓

Change Log 기록

---

# 기록 대상

Database 변경

API 변경

Security 정책 변경

Permission 변경

Design System 변경

Authentication 변경

Payment 구조 변경

Notification 구조 변경

예약 구조 변경

---

# Definition of Done

중요한 설계 변경 시

Decision Log 작성

관련 문서 업데이트

Change Log 작성

Graphify 업데이트

Claude Rule 업데이트
