# Booking App Master Specification

# 06. Testing Specification

Version : 1.0

---

# 목적

본 문서는 Booking App의 테스트 정책과 품질 기준을 정의한다.

모든 신규 기능은 본 문서를 기준으로 테스트를 수행한다.

---

# Testing Principles

모든 기능은 테스트 가능한 구조로 개발한다.

테스트 없는 기능은 완료로 인정하지 않는다.

---

# Test Pyramid

Unit Test

↓

Integration Test

↓

End-to-End Test

---

# Unit Test

목적

함수

유틸리티

비즈니스 로직

검증

---

테스트 대상

계산

Validation

Formatter

Helper

Permission Logic

Reservation Logic

Product Logic

---

목표

90% 이상 핵심 로직 테스트

---

# Integration Test

목적

API

Database

RLS

Authentication

검증

---

테스트 대상

예약 생성

예약 수정

결제

회원가입

권한 변경

환불

로그인

---

# End To End Test

사용자 기준 테스트

회원가입

↓

로그인

↓

예약

↓

결제

↓

예약 완료

↓

알림 확인

---

실제 사용자 시나리오를 기준으로 한다.

---

# Authentication Test

Email 로그인

Password 로그인

Google 로그인

Apple 로그인

Kakao 로그인

Naver 로그인

SMS 로그인

---

# Account Linking Test

Email → Kakao 연결

Email → Google 연결

Google → Apple 연결

Apple Relay Email

중복 연결 방지

본인 인증 후 연결

마지막 로그인 방식 삭제 금지

---

# Password Test

비밀번호 변경

비밀번호 찾기

Reset Token 만료

Reset Token 재사용 금지

기존 Session 종료

---

# Session Test

기기별 로그인

기기별 로그아웃

전체 로그아웃

Refresh Token Rotation

Session 만료

---

# Permission Test

관리자

직원

읽기 전용

센터 관리자

Super Admin

각 권한별 기능 검증

---

# RLS Test

다른 센터 데이터 조회 불가

다른 센터 수정 불가

권한 없는 삭제 불가

권한 없는 결제 조회 불가

---

# Reservation Test

예약 생성

예약 수정

예약 취소

예약 완료

No Show

중복 예약 방지

예약 시간 충돌

---

# Product Test

상품 생성

상품 수정

상품 삭제

수강권 차감

잔여 횟수 계산

---

# Payment Test

결제 성공

결제 실패

환불

중복 결제 방지

PG 오류 처리

---

# Notification Test

Push

SMS

Email

In App Notification

읽음 처리

중복 발송 방지

---

# Dashboard Test

통계 계산

매출 계산

예약 건수

회원 증가

차트 데이터

---

# Search Test

회원 검색

예약 검색

상품 검색

직원 검색

부분 검색

대소문자 처리

---

# API Test

모든 API

200

201

400

401

403

404

500

응답 검증

---

# Performance Test

첫 화면

2초 이하

API

500ms 이하

예약 생성

1초 이하

검색

300ms 이하

---

# Security Test

JWT 검증

Refresh Token

Rate Limit

SQL Injection

XSS

CSRF

Broken Authentication

---

# Accessibility Test

Screen Reader

Keyboard Navigation

Touch Target

Color Contrast

Dark Mode

---

# Browser Test

Chrome

Safari

Edge

Firefox

---

# Device Test

iPhone

Android

Tablet

Desktop

---

# Regression Test

기존 기능이 깨지지 않았는지 확인

예약

회원

결제

상품

권한

로그인

---

# Smoke Test

배포 직후

로그인

예약

결제

회원 조회

대시보드

정상 동작 확인

---

# Release Checklist

모든 테스트 통과

Migration 완료

RLS 확인

Activity Log 확인

API 문서 업데이트

Graphify 업데이트

Decision Log 업데이트

Change Log 업데이트

---

# Bug Severity

Critical

서비스 사용 불가

High

핵심 기능 오류

Medium

일반 기능 오류

Low

UI 문제

---

# Bug Priority

P1

즉시 수정

P2

이번 Sprint

P3

다음 Sprint

P4

추후 개선

---

# Definition of Done

새 기능 완료 조건

✓ Unit Test

✓ Integration Test

✓ E2E Test

✓ RLS Test

✓ Permission Test

✓ Activity Log 확인

✓ API 확인

✓ 문서 업데이트

✓ Graphify 업데이트
