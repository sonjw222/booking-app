# Booking App Master Specification

# 10. Claude Code Rules

Version : 1.0

---

# 목적

본 문서는 Claude Code가 Booking App 프로젝트를 개발할 때 반드시 따라야 하는 규칙을 정의한다.

모든 구현은 본 문서를 기준으로 수행한다.

---

# 최우선 원칙

기존 동작을 깨뜨리지 않는다.

작은 단위로 수정한다.

불필요한 리팩토링을 하지 않는다.

추측해서 구현하지 않는다.

문서를 먼저 확인한다.

---

# 개발 순서

기능 요청 확인

↓

관련 문서 확인

↓

Architecture 확인

↓

Database 확인

↓

API 확인

↓

Security 확인

↓

구현

↓

테스트

↓

문서 업데이트

---

# 반드시 확인할 문서

00_Project_Principles.md

01_Architecture.md

02_Database.md

03_API.md

04_UI_UX.md

05_Security.md

06_Testing.md

07_Activity_Log.md

08_Decision_Log.md

09_Change_Log.md

---

# 구현 원칙

기존 스타일 유지

기존 네이밍 유지

기존 구조 유지

중복 코드 생성 금지

불필요한 라이브러리 추가 금지

---

# 수정 원칙

필요한 파일만 수정

관련 없는 파일 수정 금지

기존 기능 변경 금지

기존 API 변경 최소화

---

# Database

Drop Table 금지

Drop Column 최소화

Migration 작성

Rollback 고려

UUID 사용

Soft Delete 유지

RLS 유지

---

# API

REST 규칙 준수

Version 유지

Response Format 유지

Error Format 유지

권한 검증 필수

---

# Authentication

Supabase Auth 사용

JWT 사용

Refresh Token Rotation 유지

Account Linking 규칙 준수

Apple Hide My Email 자동 연결 금지

---

# Authorization

RBAC 유지

Permission 확인

Server Validation

RLS 확인

---

# UI

Design Token 사용

Responsive 유지

Dark Mode 고려

Accessibility 고려

직접 색상 사용 금지

---

# Activity Log

다음 작업은 반드시 기록

예약 생성

예약 변경

예약 취소

회원 수정

권한 변경

환불

관리자 초대

Account Linking

비밀번호 변경

세션 종료

---

# Testing

Unit Test

Integration Test

E2E Test

RLS Test

Permission Test

통과 후 완료

---

# 코드 스타일

TypeScript 사용

strict mode 유지

any 사용 최소화

명확한 변수명 사용

Magic Number 금지

Magic String 최소화

---

# Component

작게 분리

재사용 가능하게 작성

단일 책임 원칙 적용

---

# State

불필요한 State 생성 금지

Prop Drilling 최소화

Server State와 Client State 구분

---

# Error Handling

모든 API

try/catch

사용자 친화적인 메시지

Activity Log 기록

---

# Performance

N+1 Query 금지

SELECT * 금지

Pagination 사용

Index 활용

Lazy Loading 고려

---

# Security

Input Validation

Output Encoding

SQL Injection 방지

XSS 방지

CSRF 대응

HTTPS Only

---

# Logging

중요 작업 기록

민감정보 기록 금지

Password 저장 금지

Token 저장 금지

---

# Documentation

새로운 기능 추가 시

관련 문서 업데이트

Decision Log 작성

Change Log 작성

---

# Git

작은 Commit

명확한 Commit Message

불필요한 파일 Commit 금지

---

# Pull Request

변경 내용

테스트 결과

영향 범위

Migration 여부

문서 변경 여부

포함

---

# 구현 금지 사항

추측 구현

하드코딩

권한 우회

비밀번호 저장

민감정보 로그 출력

테스트 생략

문서 생략

---

# 완료 조건

새 기능 구현

↓

테스트 통과

↓

문서 업데이트

↓

Decision Log 확인

↓

Change Log 작성

↓

Git Commit

↓

완료

---

# Claude Code Checklist

□ Architecture 확인

□ Database 확인

□ API 확인

□ Security 확인

□ UI 확인

□ Activity Log 적용

□ Permission 확인

□ RLS 확인

□ 테스트 작성

□ 문서 업데이트

□ Change Log 작성

□ Git Commit 준비

---

# 최종 원칙

Claude Code는

빠르게 개발하는 것보다

안정적으로 개발하는 것을 우선한다.

프로젝트의 일관성과 유지보수성을 항상 최우선으로 고려한다.
