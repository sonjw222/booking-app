# Booking App Master Specification

# 11. Development Guide

Version : 1.0

---

# 목적

본 문서는 Booking App의 표준 개발 절차를 정의한다.

새로운 기능은 반드시 본 문서를 기준으로 개발한다.

---

# 개발 원칙

기존 기능을 깨뜨리지 않는다.

작은 단위로 개발한다.

문서를 먼저 수정한다.

테스트 후 Merge한다.

---

# 개발 프로세스

요구사항 분석

↓

관련 문서 확인

↓

Decision Log 확인

↓

DB 설계 검토

↓

API 설계

↓

UI 설계

↓

구현

↓

테스트

↓

문서 업데이트

↓

Commit

↓

Pull Request

↓

Merge

---

# 새로운 기능 추가 절차

STEP 1

기능 요구사항 확인

---

STEP 2

관련 문서 확인

Architecture

Database

API

Security

UI/UX

---

STEP 3

Decision 필요 여부 확인

필요하면

Decision Log 작성

---

STEP 4

Database 변경 여부 확인

필요하면

Migration 작성

RLS 작성

Index 작성

---

STEP 5

API 변경

REST 규칙 준수

Version 유지

권한 확인

---

STEP 6

UI 구현

Design Token 사용

Responsive 확인

Dark Mode 확인

---

STEP 7

Activity Log 적용

필요한 작업은 모두 기록

---

STEP 8

테스트

Unit

Integration

E2E

---

STEP 9

문서 업데이트

Architecture

API

Decision

Change Log

---

STEP 10

Commit

명확한 Commit Message 사용

---

# 브랜치 전략

main

운영 브랜치

develop

통합 브랜치 (선택)

feature/기능명

bugfix/기능명

hotfix/기능명

---

예시

feature/member-search

feature/account-linking

bugfix/payment-error

hotfix/login-fix

---

# Commit Message 규칙

docs:

feat:

fix:

refactor:

perf:

style:

test:

build:

ci:

chore:

---

예시

feat: add reservation calendar

fix: resolve payment validation bug

docs: update API specification

---

# Pull Request 체크리스트

변경 내용 설명

테스트 완료

Migration 포함 여부

문서 업데이트 여부

Breaking Change 여부

---

# 코드 리뷰 체크리스트

기존 기능 영향

권한 확인

보안 확인

성능 확인

문서 확인

테스트 확인

---

# 코드 작성 원칙

함수는 하나의 역할만 수행한다.

중복 코드를 만들지 않는다.

하드코딩을 지양한다.

Magic Number 사용 금지.

---

# 네이밍 규칙

Component

PascalCase

예)

ReservationCard

MemberList

---

Function

camelCase

예)

createReservation()

cancelReservation()

---

Variable

camelCase

예)

memberCount

reservationDate

---

Constant

UPPER_SNAKE_CASE

예)

MAX_RETRY_COUNT

DEFAULT_PAGE_SIZE

---

# 폴더 구조

app/

components/

lib/

hooks/

services/

types/

utils/

docs/

---

# 새 기능 완료 기준

기능 구현 완료

↓

테스트 완료

↓

문서 업데이트

↓

Decision Log 확인

↓

Change Log 작성

↓

Commit

↓

PR

↓

Merge

---

# 절대 금지

테스트 없이 Merge

문서 없이 Merge

권한 우회

RLS 미적용

Activity Log 누락

하드코딩

---

# Development Checklist

□ 요구사항 확인

□ 관련 문서 확인

□ DB 변경 검토

□ API 구현

□ UI 구현

□ Activity Log 적용

□ 권한 확인

□ 테스트 완료

□ 문서 업데이트

□ Commit

□ PR
