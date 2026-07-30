# Booking App Master Specification

# 12. Deployment Guide

Version : 1.0

---

# 목적

본 문서는 Booking App의 배포 및 운영 절차를 정의한다.

개발 환경부터 운영 환경까지 모든 배포는 본 문서를 기준으로 수행한다.

---

# Deployment Architecture

Developer

↓

GitHub

↓

Vercel

↓

Production

↓

Supabase

---

# Environment

Development

↓

Preview

↓

Production

---

Development

개발 환경

---

Preview

PR 생성 시 자동 배포

---

Production

main 브랜치 배포

---

# Technology Stack

Frontend

Next.js

TypeScript

---

Backend

Supabase

---

Authentication

Supabase Auth

---

Hosting

Vercel

---

Repository

GitHub

---

# Branch Strategy

main

Production

---

develop

Development (선택)

---

feature/*

기능 개발

---

bugfix/*

버그 수정

---

hotfix/*

긴급 수정

---

# Development Flow

기능 개발

↓

테스트

↓

Commit

↓

Push

↓

Pull Request

↓

Review

↓

Merge

↓

자동 배포

---

# GitHub

모든 코드는 GitHub에서 관리한다.

직접 Production 서버 수정 금지.

---

# Vercel

main Merge

↓

자동 Build

↓

자동 Deploy

↓

Production 반영

---

PR 생성 시

Preview URL 자동 생성

---

# Supabase

Database

Authentication

Storage

Edge Functions

Realtime

사용

---

# Environment Variables

NEXT_PUBLIC_SUPABASE_URL

NEXT_PUBLIC_SUPABASE_ANON_KEY

SUPABASE_SERVICE_ROLE_KEY

NEXT_PUBLIC_APP_URL

---

민감한 환경 변수는 Git에 Commit하지 않는다.

---

# Database Migration

Migration 작성

↓

테스트

↓

Preview 확인

↓

Production 적용

---

Drop Table 금지

Rollback 고려

---

# Release Process

기능 완료

↓

테스트 완료

↓

문서 업데이트

↓

Change Log 작성

↓

Merge

↓

자동 배포

↓

Smoke Test

↓

Release 완료

---

# Smoke Test

로그인

회원 조회

예약 생성

예약 취소

결제

알림

Dashboard

확인

---

# Rollback

문제 발생 시

이전 Commit으로 Rollback

필요 시 Database Migration Rollback

---

# Monitoring

Vercel Logs

Supabase Logs

Activity Log

Error Monitoring

---

# Error Handling

Build 실패

↓

원인 확인

↓

수정

↓

재배포

---

Runtime Error

↓

로그 확인

↓

수정

↓

배포

---

# Security

HTTPS Only

Environment Variable 보호

Service Role Key 노출 금지

Production DB 직접 수정 금지

---

# Backup

Supabase Backup

Point In Time Recovery

정기 복구 테스트

---

# Release Checklist

□ 테스트 완료

□ Migration 확인

□ Environment 확인

□ API 확인

□ RLS 확인

□ Activity Log 확인

□ 문서 업데이트

□ Change Log 작성

□ Commit 완료

□ PR Merge

□ Production 확인

---

# Emergency Hotfix

hotfix 브랜치 생성

↓

수정

↓

테스트

↓

Merge

↓

자동 배포

↓

Smoke Test

---

# 운영 원칙

Production에서 직접 수정하지 않는다.

모든 변경은 GitHub를 통해 배포한다.

Preview 환경에서 충분히 검증한 후 Production에 반영한다.

---

# Definition of Done

배포 완료 후

Production 정상 동작 확인

로그 확인

Smoke Test 완료

문서 최신화

Release 완료
