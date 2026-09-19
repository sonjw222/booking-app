# Implementation Roadmap

Status: Active Development Order
Version: 1.1.0
Current-State Source: Booking App Master Spec v1.1 and Technical Roadmap
Target-State Status: Sequential; phase completion requires evidence
Last Updated: 2026-07-31

# 목적

이 문서는 기능 카탈로그가 아니라 실제 개발의 **선행 관계와 실행 순서**를 정의한다. 현재 Next.js + Supabase 구조를 안전하게 검증한 다음 DB·아키텍처·핵심 비즈니스 흐름을 강화하고, 외부 조건이 필요한 결제·알림·SaaS 기능은 후반 Phase에서 승인 후 진행한다.

상세 제품 상태는 [Project Principles](./00_Project_Principles.md), [Architecture](./01_Architecture.md), [Database](./02_Database.md), [Security](./05_Security.md), [Technical Roadmap](./12_Roadmap.md)을 따른다.

# 개발 원칙

- 각 Phase는 `Current 확인 → Intermediate 구현 → 증거 확보` 후 다음 Phase로 넘어간다.
- RLS/RPC와 센터·Profile 격리를 UI보다 먼저 검증한다.
- 운영 Supabase 적용 상태를 저장소 SQL의 존재만으로 추정하지 않는다.
- 외부 secret은 Client Component나 `NEXT_PUBLIC_*`에 넣지 않는다.
- 실제 PG, 외부 알림, 공개 API는 제품·공급자 결정 전에 구현하지 않는다.
- 문서, migration, 타입, 테스트가 서로 다른 상태를 가리키면 완료로 처리하지 않는다.
- Phase 번호는 제품 출시 순서가 아니라 기술 위험을 줄이는 순서다.

# 구현 우선순위

| Order | Phase | Outcome |
|---:|---|---|
| 0 | 문서·운영 기준 | 구현과 운영 환경의 사실 기준 확정 |
| 1 | 보안·격리 | RLS/권한/센터 격리 검증 |
| 2 | DB 기반 | 재현 가능한 migration·RPC·타입 |
| 3 | 구조·성능 | 안전한 리팩터링 경계와 측정 기준 |
| 4 | 핵심 도메인 | 예약·출석·수강권·주문 안정화 |
| 5 | 금전 흐름 | 승인된 PG·환불의 서버 경계 |
| 6 | 운영 정보 | 알림·CRM·분석의 정확성과 정책 |
| 7 | 확장 | 승인된 마케팅·SaaS·개발자 플랫폼 |

# Phase 0 — 문서 정합성·운영 설정·Supabase 설정

## 목적

코드, Master Spec, 저장소 SQL, 운영 Supabase의 차이를 식별해 이후 작업이 잘못된 가정 위에서 진행되지 않게 한다.

## 포함 기능

- Master Spec Current/Intermediate/Target 상태 검토
- 운영 Supabase 프로젝트와 환경 구분
- Auth Provider, redirect URL, 이메일 정책 확인
- 적용 migration/RPC/RLS/Storage/Realtime/cron 상태 확인
- 현재 CI/CD와 배포 환경의 사실 조사

## 선행 조건

- 운영/스테이징 Supabase의 읽기 가능한 설정 증거
- 비밀값을 노출하지 않는 접근 방법
- 환경별 책임자와 검증 범위

## 완료 조건

- 저장소 SQL과 운영 적용 상태의 차이 목록
- Blocked 항목마다 책임자·필요 결정·검증 방법 기록
- OAuth/Realtime/Storage/cron의 현재 상태가 증거와 함께 분류됨
- 문서의 Current State가 실제 환경과 일치함

## Blocked By

- Supabase Dashboard 및 migration 이력 접근
- OAuth 공급자 계정/redirect 설정
- 배포·CI 관리 권한

## 예상 위험

- 저장소 SQL은 있으나 운영에 미적용
- 환경 간 RLS/RPC 버전 차이
- 설정 확인 중 비밀값 또는 개인정보 노출

## 산출물

- 운영 설정 체크리스트
- schema/policy/RPC drift 보고서
- Blocked/Decision Required 목록
- 갱신된 ADR과 검증 증거

# Phase 1 — Security·RLS·권한·Data Isolation

## 목적

기능 확장 전에 Account/Profile/Center 경계와 Platform/Center 권한을 DB에서 확실히 강제한다.

## 포함 기능

- `accounts`, `profiles`, `manager_centers` 소유·소속 검증
- custom role, role permission, 개인 allow/deny
- Platform Admin 분리
- table/view/RPC/Storage/Realtime의 A/B 센터 격리
- 직접배치·무료배치·정원 초과 권한
- SQL function security와 execute grant 감사

## 선행 조건

- Phase 0의 운영 적용 상태 확인
- 테스트용 Account/Profile/Center A·B fixture
- 역할 관리 및 직접배치 permission 결정

## 완료 조건

- 교차 Account/Profile/Center 접근 부정 테스트 통과
- UI guard가 없어도 RLS/RPC가 민감 작업을 차단
- owner/custom role/personal override 우선순위 검증
- Security 문서와 실제 policy/RPC가 일치

## Blocked By

- 운영/테스트 Supabase 접근
- 마지막 owner·owner 이전 정책
- 직접배치/무료배치 permission와 정지·탈퇴 회원 정책

## 예상 위험

- RLS 강화로 기존 화면이 실패
- `SECURITY DEFINER` 함수의 우회 경로
- Realtime/view/Storage에 누락된 tenant filter

## 산출물

- 권한 매트릭스
- RLS/RPC/Storage/Realtime 부정 테스트
- 보안 감사 결과와 수정 계획
- permission-aware UI gap 목록

# Phase 2 — Database·Migration·RPC·Type

## 목적

누적 SQL을 재현 가능한 migration 체계로 정리하고 앱과 DB 계약을 타입과 테스트로 고정한다.

## 포함 기능

- migration source of truth
- fresh DB 재현과 seed/fixture
- 핵심 RPC 입력·출력·권한·원자성 검증
- Supabase Database/RPC TypeScript 타입 생성
- 스키마 drift 검사

## 선행 조건

- Phase 1의 권한 기준
- 운영 migration 이력 확보
- migration 도구와 baseline 전략 결정

## 완료 조건

- 빈 환경에서 순서대로 스키마 재현
- 핵심 RPC 통합 테스트 통과
- 앱이 생성된 타입을 사용할 전환 계획 확보
- 운영 적용 전 migration 검토·rollback/forward-fix 절차 존재

## Blocked By

- 운영 DB baseline 및 migration 이력
- Supabase CLI/도구 결정
- 기존 데이터 backfill·호환 정책

## 예상 위험

- 중복/순서 의존 SQL
- 운영 drift로 인한 migration 충돌
- 생성 타입 도입 시 다수의 기존 `any` 오류 노출

## 산출물

- 정렬된 migration 계획
- fresh DB 검증 스크립트/CI 항목
- 생성 DB 타입
- RPC 계약 및 drift 보고서

# Phase 3 — Architecture·Refactoring·Performance

## 목적

보안·DB 계약을 유지하면서 `app → lib → Supabase` 구조를 명확히 하고 측정된 병목만 개선한다.

## 포함 기능

- `lib` 도메인 경계와 오류 계약 정리
- 공통 Account/Profile/Center context
- permission-aware UI guard
- query 수, payload, latency 측정
- pagination, index, N+1 개선
- 외부 secret이 필요한 server boundary 후보 설계

## 선행 조건

- Phase 1 보안 테스트
- Phase 2 타입·RPC 계약
- 주요 화면 성능 baseline

## 완료 조건

- 핵심 화면이 동일한 도메인·오류·권한 패턴 사용
- 리팩터링 전후 회귀 테스트 통과
- 성능 변경이 측정값으로 설명됨
- Route Handler/Edge Function은 필요 근거와 ADR 없이는 추가되지 않음

## Blocked By

- 성능 SLO/측정 환경
- Route Handler vs Edge Function 결정
- 센터별 timezone 지원 결정

## 예상 위험

- 대규모 리팩터링으로 기능 회귀
- UI 캐시/Realtime subscription의 센터 상태 누수
- 근거 없는 서버화 또는 캐시 도입

## 산출물

- 모듈 경계·오류 계약
- 공통 context/guard 설계
- 성능 baseline과 개선 결과
- server boundary ADR

# Phase 4 — Reservation·Attendance·Membership·Order

## 목적

현재 구현된 핵심 업무 흐름을 통합 회귀 테스트와 명시적 상태 전이로 안정화한다.

## 포함 기능

- 예약·취소·대기·자동승격·중복 방지
- 출석·노쇼
- 수강권 발급·차감·복원·공유·자동예약·미배치
- 관리자 직접배치·무료배치·감사
- 상품·주문·발급 상태 전이

## 선행 조건

- Phase 1의 권한/격리
- Phase 2의 migration/RPC/type
- 수강권 공식 용어와 예약/출석 정책

## 완료 조건

- 정상·거부·동시성·중복 호출 테스트 통과
- 수강권 잔여 횟수와 주문 발급이 중복/음수가 되지 않음
- 관리자 배치 유형별 차감·감사 규칙 검증
- 주문과 결제 상태가 혼동되지 않음

## Blocked By

- 직접배치 permission와 회원 상태 정책
- 수강권/이용권 명칭
- 주문 취소·수강권 환불 정책

## 예상 위험

- 여러 세대 RPC 간 규칙 불일치
- 대기 승격·자동예약 동시성
- 주문 재처리로 중복 수강권 발급

## 산출물

- 핵심 도메인 상태 전이 표
- 예약/출석/수강권/주문 통합 테스트
- RPC 정합성 보고서
- 운영 runbook

# Phase 5 — Payment·Refund·PG

## 목적

Mock 결제와 운영 결제를 명확히 분리하고 실제 금전 흐름을 신뢰 가능한 서버 경계에서 처리한다.

## 포함 기능

- PG Provider 선택
- 결제 생성·승인·실패·취소·조회
- webhook 서명 검증과 replay/idempotency
- 주문·`payments`·수강권 발급 연계
- 부분/전체 환불 및 실패 복구

## 선행 조건

- Phase 4 주문/수강권 상태 안정화
- PG·가맹점·환불 정책
- Phase 3 server boundary ADR
- 회계/원장 source of truth

## 완료 조건

- secret이 브라우저에 노출되지 않음
- sandbox에서 성공·실패·취소·중복 webhook 테스트 통과
- 내부 상태와 PG 상태 불일치 복구 절차 존재
- Mock과 운영 Provider가 명확히 분리됨

## Blocked By

- Toss/PortOne/기타 PG 결정과 계약
- server runtime/Edge Function 결정
- 환불·회계·개인정보 정책

## 예상 위험

- 결제 성공 후 내부 발급 실패
- webhook 중복·순서 역전
- 금액/주문 소유권 변조

## 산출물

- PG ADR·Provider 구현
- webhook endpoint와 idempotency 저장
- 결제/환불 통합 테스트
- 정산·장애 대응 runbook

# Phase 6 — Notification·CRM·Analytics

## 목적

현재 운영 데이터와 알림 기능을 검증하고 개인정보·권한·정확성이 확보된 범위에서 운영 역량을 강화한다.

## 포함 기능

- Realtime 알림과 문의
- 예약 리마인드·수강권 만료 scheduler
- 외부 푸시/알림톡 후보
- 센터 회원·등급·상태·진도·문의
- 매출·예약·운영 지표 정의

## 선행 조건

- Phase 1 격리·권한
- Phase 4 핵심 상태 신뢰성
- 알림 채널, CRM 범위, KPI 결정

## 완료 조건

- 알림 대상과 Center/Profile 격리 검증
- scheduler 재실행·중복 발송 정책 존재
- CRM 개인정보 접근과 보존 정책 적용
- 분석 지표가 지정된 원장과 재현 가능한 집계를 사용

## Blocked By

- 메시지 공급자, pg_cron/스케줄러 운영 설정
- 개인정보·수신 동의 정책
- CRM 제품 범위와 KPI 정의

## 예상 위험

- 중복/오발송
- 센터 간 회원 정보 노출
- 클라이언트 집계와 원장 불일치

## 산출물

- 알림 이벤트·재시도 계약
- CRM 권한·보존 기준
- 지표 사전과 검증 query
- 운영 모니터링 대시보드 정의

# Phase 7 — Marketing·Platform SaaS·Developer Platform

## 목적

핵심 운영과 보안이 안정된 뒤, 명시적으로 승인된 사업 요구만 확장한다.

## 포함 기능

- 기존 카테고리·배너·센터 소개·후기·공지 강화
- Platform Admin guard와 센터 상태 감사
- 승인 시 SaaS 플랜/과금
- 승인 시 외부 API/SDK/webhook

## 선행 조건

- Phase 0~6 완료 증거
- 사업 모델과 파트너 요구
- 개인정보·과금·API 보안 정책

## 완료 조건

- 새 기능이 Master Spec/ADR에 승인됨
- Center tenant isolation과 Platform Admin 권한 검증
- 외부 API가 있다면 버전·인증·rate limit·감사 계약 존재
- 마케팅 기능이 수신 동의와 개인정보 정책을 준수

## Blocked By

- SaaS 가격·플랜·과금 정책
- 캠페인/세그먼트 제품 요구
- 파트너 API 요구와 지원 정책
- 법률·개인정보 검토

## 예상 위험

- 근거 없는 플랫폼 추상화
- 플랫폼 운영자 권한 과다
- 외부 API로 tenant 데이터 노출
- 제품 범위와 로드맵의 혼합

## 산출물

- 승인된 제품/기술 ADR
- Platform Admin 보안 테스트
- 필요 시 API/webhook 계약
- 운영·지원·폐기 정책

# Roadmap 충돌 기록

Backlog와 충돌하는 경우 `docs/19_Project_Backlog.md`를 수정하지 않고 여기에 기록한다.

| Date | Phase | Backlog Reference | Conflict Reason | Required Decision |
|---|---|---|---|---|
| - | - | - | 현재 확인된 충돌 없음 | - |

# AI Working Rules

1. AI는 항상 `Current → Intermediate → Target` 순으로 구현한다. 절대로 Current에서 Target으로 점프하지 않는다.
2. `Blocked By`가 있는 기능은 승인 없이 구현하지 않는다.
3. Master Spec가 항상 SSOT다. Roadmap는 구현 순서만 정의한다.
4. Roadmap는 제품 요구사항을 변경하지 않는다.
5. Backlog와 충돌하면 Backlog를 수정하지 말고 Roadmap에 이유를 기록한다.

