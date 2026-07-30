# Booking App Master Specification

# 16. Troubleshooting Guide

Version : 1.0

---

# 목적

본 문서는 Booking App 개발 및 운영 중 발생할 수 있는 문제와 해결 방법을 기록한다.

동일한 문제가 반복되지 않도록 원인과 해결 과정을 함께 기록한다.

---

# 작성 원칙

모든 이슈는 다음 항목을 포함한다.

Issue ID

Date

Category

Symptoms

Cause

Solution

Prevention

Related Documents

---

# Issue Categories

Development

Database

Authentication

Deployment

Git

Performance

Security

UI

API

Testing

---

# ISSUE-001

Title

Supabase Environment Variable Error

Symptoms

supabaseKey is required

Cause

환경 변수가 설정되지 않음

Solution

NEXT_PUBLIC_SUPABASE_URL 확인

NEXT_PUBLIC_SUPABASE_ANON_KEY 확인

Vercel Environment Variables 확인

Prevention

새 프로젝트 생성 시 환경 변수 체크리스트 수행

---

# ISSUE-002

Title

Next.js useEffect Dependency Warning

Symptoms

The final argument passed to useEffect changed size between renders

Cause

Dependency Array 길이가 변경됨

Solution

Dependency Array 길이를 항상 동일하게 유지

조건부 Dependency 사용 금지

Prevention

ESLint Hook Rules 사용

---

# ISSUE-003

Title

Vercel Build Failed

Symptoms

Build Error

Cause

환경 변수

Type Error

Lint Error

Solution

Local Build 확인

Type Check 확인

Environment 확인

---

# ISSUE-004

Title

Git Push Failed

Symptoms

Authentication Failed

Cause

SSH 설정 오류

Solution

SSH Key 등록

Remote 확인

GitHub 인증 확인

---

# ISSUE-005

Title

RLS Permission Denied

Symptoms

Permission Denied

Cause

RLS 정책 누락

Solution

Policy 확인

Role 확인

JWT 확인

---

# ISSUE-006

Title

Reservation Creation Failed

Symptoms

예약 생성 실패

Cause

상품 상태

권한

예약 중복

Solution

Validation 확인

Activity Log 확인

---

# ISSUE-007

Title

Payment Failed

Symptoms

결제 실패

Cause

PG 오류

Validation 오류

Solution

PG 응답 확인

Retry 여부 확인

---

# ISSUE-008

Title

Account Linking Failed

Symptoms

로그인 방식 연결 실패

Cause

이미 연결됨

본인 인증 실패

Apple Relay Email

Solution

Identity 확인

Verification 확인

---

# ISSUE-009

Title

Migration Failed

Symptoms

Migration Error

Cause

기존 데이터 충돌

Constraint 오류

Solution

Migration Rollback

Data 확인

---

# ISSUE-010

Title

Performance Degradation

Symptoms

화면 느림

API 느림

Cause

N+1 Query

Index 누락

Solution

Index 추가

Query 최적화

Pagination

---

# Debug Checklist

□ 로그 확인

□ Environment 확인

□ API 확인

□ RLS 확인

□ Permission 확인

□ Activity Log 확인

□ Database 확인

□ Migration 확인

---

# Logging Strategy

Development

Console

---

Production

Structured Logging

Error Monitoring

Activity Log

---

# Recovery Process

문제 확인

↓

원인 분석

↓

수정

↓

테스트

↓

배포

↓

Smoke Test

↓

문서 업데이트

---

# Prevention Rules

동일 문제 재발 방지

문서 업데이트

Decision Log 검토

테스트 추가

---

# Useful Commands

npm run dev

npm run build

npm run lint

npm run type-check

git status

git pull

git push

---

# Related Documents

05_Security.md

06_Testing.md

10_Claude_Rules.md

11_Development_Guide.md

12_Deployment.md

---

# Definition of Done

새로운 문제 해결 시

Troubleshooting 문서 업데이트

원인 기록

해결 방법 기록

재발 방지 방법 기록
