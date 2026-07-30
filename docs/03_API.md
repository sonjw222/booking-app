# Booking App Master Specification

# 03. API Specification

Version : 1.0

---

# 목적

본 문서는 Booking App의 API 설계 원칙을 정의한다.

모든 API는 본 문서를 기준으로 구현한다.

---

# API Style

REST API

HTTPS Only

JSON Request

JSON Response

UTF-8

---

# API Version

모든 API는 Version을 가진다.

예)

GET /api/v1/members

POST /api/v1/reservations

---

# Response Format

성공

{
  "success": true,
  "data": {}
}

실패

{
  "success": false,
  "error": {
      "code": "...",
      "message": "..."
  }
}

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

JWT 사용

---

# Authorization

Role

↓

Permission

↓

Server Validation

↓

RLS

클라이언트는 권한을 신뢰하지 않는다.

---

# Organization APIs

GET /organizations

GET /organizations/{id}

POST /organizations

PATCH /organizations/{id}

DELETE /organizations/{id}

---

# Center APIs

GET /centers

GET /centers/{id}

POST /centers

PATCH /centers/{id}

DELETE /centers/{id}

---

# Member APIs

GET /members

GET /members/{id}

POST /members

PATCH /members/{id}

DELETE /members/{id}

회원 검색

회원 메모

회원 태그

회원 상태 변경

---

# Reservation APIs

GET /reservations

GET /reservations/{id}

POST /reservations

PATCH /reservations/{id}

DELETE /reservations/{id}

예약 취소

예약 변경

예약 담당자 변경

예약 완료

예약 No Show

---

# Product APIs

GET /products

POST /products

PATCH /products

DELETE /products

수강권

PT

요가

필라테스

이용권

---

# Payment APIs

GET /payments

POST /payments

POST /refunds

GET /receipts

---

# Staff APIs

GET /staff

POST /staff

PATCH /staff

DELETE /staff

권한 수정

센터 이동

초대

비활성화

---

# Role APIs

GET /roles

POST /roles

PATCH /roles

DELETE /roles

Permission 관리

---

# Notification APIs

GET /notifications

PATCH /notifications/read

DELETE /notifications

---

# Dashboard APIs

GET /dashboard

GET /dashboard/sales

GET /dashboard/reservations

GET /dashboard/members

---

# Authentication APIs

POST /auth/signup

POST /auth/login

POST /auth/logout

POST /auth/refresh

POST /auth/forgot-password

POST /auth/reset-password

POST /auth/change-password

POST /auth/verify-email

POST /auth/send-sms

POST /auth/verify-sms

---

# Social Login APIs

POST /auth/google

POST /auth/kakao

POST /auth/apple

POST /auth/naver

---

# Account Linking APIs

GET /account/identities

POST /account/link

DELETE /account/unlink

---

규칙

자동 병합 금지

본인 인증 후 연결

Apple Hide My Email 자동 연결 금지

마지막 로그인 수단 삭제 금지

---

# Session APIs

GET /sessions

DELETE /sessions/{id}

DELETE /sessions/all

---

사용자는

현재 로그인된 기기 확인

기기별 로그아웃

전체 로그아웃

을 지원한다.

---

# Search

GET /search

검색 대상

회원

예약

상품

직원

---

# Pagination

page

limit

sort

order

지원

---

# Filtering

status

center

staff

date

product

member

---

# Error Codes

UNAUTHORIZED

FORBIDDEN

NOT_FOUND

VALIDATION_ERROR

RATE_LIMIT

CONFLICT

SERVER_ERROR

---

# Activity Log

다음 API는 반드시 Activity Log를 기록한다.

예약 생성

예약 취소

회원 수정

권한 변경

관리자 초대

상품 수정

환불

로그인 방식 연결

비밀번호 변경

세션 종료

---

# Rate Limit

로그인

SMS

비밀번호 찾기

회원가입

은 Rate Limit 적용

---

# Security

HTTPS Only

JWT

Refresh Token Rotation

Input Validation

SQL Injection 방지

XSS 방지

CSRF 대응

민감정보 암호화

---

# API Naming Rules

동사 사용 금지

좋은 예

GET /members

POST /payments

나쁜 예

/getMembers

/doReservation

---

# Definition of Done

새로운 API 추가 시

API 문서 업데이트

권한 검증

RLS 검증

테스트 작성

Activity Log 적용

Change Log 업데이트
