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

# DEC-011

Title

휴무일 강제취소 수강권 복구(P0-6) + 운영설정 예약 로직 배선(P1-12)

Date

2026-08-02

Status

Proposed (SQL 미실행 — 실행 승인 대기)

Category

예약 구조 변경

Decision

`add_holiday_safe`가 강제 삭제하는 예약 중 실제로 수강권을 차감한(`membership_consumed`,
`status in ('confirmed','attended')`) 것만 `remaining_count`를 복구하도록 수정한다. 삭제 기반
구조(예약/수업 row 자체를 지움)는 그대로 유지한다 — `reservations.class_id`에
`ON DELETE CASCADE`가 없어 UPDATE-cancelled 방식으로 바꾸면 `delete from classes`가 FK 위반으로
실패하고, `delete_class_safe`도 동일하게 삭제 기반이라 아키텍처를 새로 만들지 않는다.
또한 `center_settings`의 34개 필드 중 `reserve_class()`의 기존 동기 검증 흐름에 자연스럽게
추가 가능한 8개(당일예약 허용/일일예약 한도/주간 대기예약 한도/예약 오픈 시각)를
`calc_deadline()`(`'open'` kind 신설)과 `reserve_class()`에 배선한다.

Reason

두 문제 모두 회원의 수강권(재화) 손실 또는 매니저가 설정한 운영 정책이 조용히 무시되는 신뢰
문제로, Track B 감사(2026-08-02)에서 발견해 SQL 승인 대기 상태로 기록해 두었던 항목이다.

Alternatives

(P0-6) `add_holiday_safe`를 UPDATE-cancelled 기반으로 재작성 — FK 제약상 불가(위 Decision 참고).
(P1-12) 34개 필드 전부를 한 번에 배선 — 스케줄러 인프라나 신규 UI가 선행되어야 하는 17개는
이번 범위에서 제외하고 감사 문서([24_P1_12_Settings_Audit.md](./24_P1_12_Settings_Audit.md))로만
기록.

Pros

기존 함수 시그니처·반환값·다른 호출부(`admin_assign_reservation` 등)를 전혀 바꾸지 않고 순수
추가만으로 해결. 기존 취소 경로(`cancel_reservation`/`admin_cancel_reservation`)의 복구 조건과
일관성을 맞춤.

Cons

`reserve_class()`는 앱에서 가장 많이 호출되는 RPC라 새 차단 조건 추가가 P0-6보다 위험도가 높음
— 별도로 신중히 검토 후 실행 권장.

Impact

`add_holiday_safe`, `calc_deadline`, `reserve_class` 3개 RPC. 영향받는 테이블: `reservations`,
`memberships`, `classes`, `center_holidays`, `center_settings`(읽기만).

Related Documents

[fix_holiday_membership_restore_draft_proposed.sql](../fix_holiday_membership_restore_draft_proposed.sql),
[fix_settings_wire_reservation_logic_draft_proposed.sql](../fix_settings_wire_reservation_logic_draft_proposed.sql),
[24_P1_12_Settings_Audit.md](./24_P1_12_Settings_Audit.md), [TODO.md](./TODO.md) P0-6/P1-12

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
