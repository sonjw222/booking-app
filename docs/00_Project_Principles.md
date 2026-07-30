# Booking App Master Specification v1.0

Version : 1.0

Status : Draft

Owner : Product Team

Last Updated : 2026

---

# 목적

본 문서는 Booking App의 공식 개발 명세서이다.

모든 신규 기능은 본 문서를 기준으로 설계 및 구현한다.

Claude Code, ChatGPT 및 개발자는 본 문서를 프로젝트의 단일 기준(Single Source of Truth)으로 사용한다.

---

# 프로젝트 목표

예약부터 결제, 회원관리, 직원관리, 관리자 기능까지 하나의 플랫폼에서 운영 가능한 SaaS 예약 시스템 구축

지원 플랫폼

- iOS
- Android
- Web

향후 Desktop Admin 지원 예정

---

# 핵심 가치

1.
쉬운 사용성

예약은 누구나 1분 안에 완료할 수 있어야 한다.

2.

빠른 속도

사용자는 화면 전환 지연을 거의 느끼지 않아야 한다.

3.

안정성

예약 데이터는 절대 유실되지 않는다.

4.

확장성

새로운 센터 및 새로운 업종을 쉽게 추가할 수 있어야 한다.

5.

보안

회원정보와 결제정보는 최고 수준으로 보호한다.

---

# 디자인 철학

Apple 수준의 단순함

+

토스 수준의 직관성

+

배민 수준의 친근함

모든 화면은

"처음 사용하는 사람도 설명 없이 사용할 수 있는 UI"

를 목표로 한다.

---

# 개발 원칙

## 기존 기능 보호

기존 기능을 깨뜨리는 수정은 금지한다.

Backward Compatibility를 유지한다.

기존 API는 가능한 유지한다.

---

## Migration Only

테이블 Drop 금지

컬럼 삭제 최소화

Migration을 통해 변경한다.

---

## Soft Delete

회원

예약

상품

직원

센터

삭제는 Soft Delete를 원칙으로 한다.

---

## Audit First

모든 관리자 작업은 Activity Log에 기록한다.

예)

예약 취소

직원 추가

권한 변경

가격 수정

회원 삭제

관리자 초대

센터 생성

센터 삭제

---

## Undo First

복구 가능한 작업은 Undo를 지원한다.

예)

예약 취소

회원 삭제

직원 삭제

상품 삭제

공지 삭제

---

## Permission First

권한은 UI가 아니라 서버에서 검사한다.

UI는 단지 버튼을 숨길 뿐이다.

실제 권한은

Server

RLS

RPC

에서 검증한다.

---

## Security First

모든 인증은

JWT

Session

Refresh Token

RLS

Rate Limit

기준으로 설계한다.

---

## Testing First

새 기능은 반드시 테스트를 포함한다.

Unit Test

Integration Test

E2E Test

Migration Test

RLS Test

Permission Test

---

## Documentation First

기능 구현 후 반드시

docs

Graphify

CHANGELOG

Decision Log

업데이트

---

# Git 전략

main

항상 배포 가능한 상태 유지

feature 브랜치에서 개발

PR 생성

Code Review

Merge

---

브랜치 예시

feature/admin-dashboard

feature/multi-center

feature/account-linking

feature/social-login

feature/password-reset

---

# Claude Code 작업 원칙

Claude는

절대 기존 기능을 임의 삭제하지 않는다.

절대 Drop Migration을 생성하지 않는다.

절대 RLS를 제거하지 않는다.

절대 테스트를 삭제하지 않는다.

절대 Activity Log를 무시하지 않는다.

---

Claude는 구현 전

현재 프로젝트를 분석한다.

영향받는 파일 목록 작성

구현 계획 작성

Migration 작성

테스트 작성

문서 업데이트

순서대로 진행한다.

---

# ChatGPT 역할

아키텍처 검토

보안 검토

DB 검토

UX 검토

Claude 결과 리뷰

리팩토링 제안

---

# Definition of Done

기능은 다음 조건을 만족해야 완료로 인정한다.

✓ UI 구현

✓ API 구현

✓ DB Migration

✓ RLS 적용

✓ Activity Log 적용

✓ 테스트 통과

✓ 문서 업데이트

✓ Graphify 업데이트

✓ PR 생성

---

# 향후 EPIC

EPIC 1

관리자 시스템

EPIC 2

멀티센터

권한

관리자 초대

EPIC 3

인증

회원가입

소셜 로그인

Account Linking

비밀번호 찾기

Session

기기관리

EPIC 4~

향후 추가
