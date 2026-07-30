# Booking App Master Specification

# 14. Coding Convention

Version : 1.0

---

# 목적

본 문서는 Booking App 프로젝트의 코딩 규칙을 정의한다.

모든 코드는 본 문서를 기준으로 작성한다.

---

# 기본 원칙

가독성을 최우선으로 한다.

명확한 이름을 사용한다.

작게 나눈다.

중복을 줄인다.

일관성을 유지한다.

---

# Tech Stack

Next.js

TypeScript

React

Supabase

Tailwind CSS

---

# TypeScript

strict mode 유지

unknown 사용 권장

any 사용 금지 (불가피한 경우 주석 작성)

명시적인 타입 선언

---

# React

Function Component만 사용

Hook 규칙 준수

Custom Hook 적극 활용

불필요한 useEffect 사용 금지

---

# Next.js

App Router 사용

Server Component 우선

필요한 경우만 Client Component

Server Action 적극 활용

---

# Folder Structure

app/

components/

features/

hooks/

lib/

services/

types/

utils/

docs/

---

# Feature Structure

feature/

components/

hooks/

services/

types/

utils/

---

# File Naming

Component

PascalCase

예)

ReservationCard.tsx

---

Hook

useReservation.ts

---

Utility

reservation.ts

date.ts

price.ts

---

Type

reservation.ts

member.ts

---

# Variable Naming

camelCase

예)

memberCount

reservationDate

---

# Constant

UPPER_SNAKE_CASE

예)

MAX_LOGIN_RETRY

DEFAULT_PAGE_SIZE

---

# Boolean

is

has

can

should

예)

isAdmin

hasPermission

canEdit

shouldRefresh

---

# Function

동사로 시작

createReservation

cancelReservation

updateMember

deleteProduct

---

# Component Rules

한 Component는 하나의 책임만 가진다.

300줄 이상이면 분리를 검토한다.

---

# Hook Rules

UI와 비즈니스 로직을 분리한다.

Custom Hook으로 재사용한다.

---

# State Management

Server State

Client State

명확히 구분한다.

---

# API

API 호출은 services에서 관리한다.

Component에서 fetch 직접 사용을 지양한다.

---

# Error Handling

try/catch 사용

사용자 친화적 메시지 제공

에러 로그 기록

---

# Comments

왜(Why)를 설명한다.

무엇(What)은 코드로 표현한다.

---

# Imports

외부 라이브러리

↓

내부 라이브러리

↓

컴포넌트

↓

스타일

순으로 정렬한다.

---

# Styling

Tailwind 우선

인라인 스타일 지양

Design Token 사용

---

# Performance

Memoization은 필요한 경우만

Lazy Loading 활용

N+1 Query 금지

---

# Security

Input Validation

Output Encoding

권한 확인

민감정보 로그 금지

---

# Testing

새 기능은 테스트 포함

버그 수정은 회귀 테스트 추가

---

# Git

작은 단위 Commit

의미 있는 Commit Message

---

# Pull Request

변경 이유

테스트 결과

영향 범위

문서 변경 여부

작성

---

# 금지 사항

any 남발

하드코딩

중복 코드

거대한 Component

권한 우회

테스트 생략

문서 생략

---

# Code Review Checklist

□ 네이밍 확인

□ 타입 확인

□ 성능 확인

□ 보안 확인

□ 테스트 확인

□ 문서 확인

---

# Definition of Done

기능 구현

↓

Lint 통과

↓

Type Check 통과

↓

Test 통과

↓

문서 업데이트

↓

Commit
