# Booking App Master Specification

# 05. Security Specification

Version : 1.0

---

# 목적

본 문서는 Booking App의 보안 정책을 정의한다.

모든 인증, 권한, 개인정보 보호, 세션 관리는 본 문서를 기준으로 구현한다.

---

# Security Principles

보안은 선택 사항이 아니다.

모든 기능은 기본적으로 Secure By Default 원칙을 따른다.

---

# Authentication

지원

Email

Password

Kakao

Apple

Google

Naver

SMS

---

모든 로그인은

Supabase Auth 기반으로 구현한다.

---

# Authorization

권한은

Role

↓

Permission

↓

Server Validation

↓

RLS

순으로 검사한다.

UI 권한은 신뢰하지 않는다.

---

# JWT

모든 인증은 JWT 기반으로 수행한다.

JWT에는 최소 정보만 포함한다.

User ID

Session ID

Role

Center ID

---

민감한 개인정보는 JWT에 저장하지 않는다.

---

# Refresh Token

Refresh Token Rotation 사용

Refresh Token 재사용 금지

탈취 의심 시 즉시 폐기

---

# Session

Session은 기기별로 생성한다.

예)

iPhone

Mac

Windows

Android

Tablet

각각 독립 Session

---

# Session Management

사용자는

현재 로그인된 기기 확인

기기별 로그아웃

전체 로그아웃

최근 로그인 시간 확인

을 지원한다.

---

# Device Information

기록

OS

Browser

IP

Country

Last Active

Created At

---

# Password Policy

최소 8자

대문자 권장

소문자 권장

숫자 포함 권장

특수문자 권장

---

이미 사용했던 비밀번호 재사용 제한(선택)

---

# Password Storage

비밀번호는 절대 저장하지 않는다.

Hash만 저장한다.

---

# Password Reset

Email Verification

↓

Reset Token

↓

Password 변경

↓

기존 Session 무효화(Optional)

↓

Activity Log 기록

---

# Email Verification

회원가입 후

Email Verification 수행

인증 전까지 일부 기능 제한 가능

---

# SMS Verification

휴대폰 인증은

1회용 코드(OTP) 사용

코드 만료

5분

재사용 금지

---

# Social Login

지원

Kakao

Apple

Google

Naver

---

# Account Linking

한 사용자

↓

여러 로그인 방식 연결

Email

Kakao

Apple

Google

Naver

---

자동 병합 금지

본인 인증 후 연결

---

# Apple Hide My Email

Relay Email은

자동 연결 금지

반드시 사용자 확인 후 연결

---

# Login Method Management

사용자는

현재 연결된 로그인 방식 확인

새 로그인 방식 연결

로그인 방식 해제

지원

---

마지막 로그인 방식은 삭제할 수 없다.

---

# Rate Limit

로그인

회원가입

SMS

비밀번호 찾기

Email 인증

API 호출

Rate Limit 적용

---

# Login Failure

로그인 실패 횟수 기록

일정 횟수 이상 실패 시

일시 잠금

---

# API Security

HTTPS Only

Input Validation

Output Encoding

SQL Injection 방지

XSS 방지

CSRF 대응

---

# Database Security

RLS 활성화

민감정보 암호화

Foreign Key 사용

Soft Delete

Audit Log

---

# Encryption

HTTPS

TLS

Password Hash

민감정보 암호화

---

# Personal Information

최소 정보만 수집

불필요한 개인정보 저장 금지

---

# Logging

다음 작업은 기록

로그인

로그아웃

비밀번호 변경

권한 변경

관리자 초대

환불

예약 취소

Account Linking

Session 종료

---

# Activity Log

기록 항목

누가

언제

무엇을

왜

IP

Device

---

# Sensitive Actions

삭제

환불

권한 변경

센터 삭제

관리자 삭제

비밀번호 변경

재인증 요구 가능

---

# Admin Security

관리자 권한은 최소 권한 원칙 적용

Super Admin만 가능한 작업은 명확히 분리한다.

---

# Permission Principle

필요한 권한만 부여

기본은 최소 권한

---

# Backup

자동 백업

Point In Time Recovery

정기 복구 테스트

---

# Monitoring

비정상 로그인 감지

과도한 API 호출 감지

비정상 Session 감지

권한 오남용 감지

---

# Future Security

2FA

Authenticator App

Passkey

Biometric Login

Hardware Key

지원 예정

---

# OWASP

OWASP Top 10 대응

SQL Injection

XSS

CSRF

Broken Authentication

Sensitive Data Exposure

Broken Access Control

Security Misconfiguration

---

# Definition of Done

새로운 인증 기능 추가 시

권한 검토

RLS 검토

Activity Log 적용

Rate Limit 적용

테스트 작성

문서 업데이트

Decision Log 업데이트
