# Booking App Master Specification

# 01. Architecture

Version : 1.0

---

# 목적

Booking App 전체 시스템 구조를 정의한다.

본 문서는

- Backend
- Frontend
- Database
- Authentication
- Authorization
- Reservation
- Payment
- Notification

모든 기능의 기준이 된다.

---

# 전체 시스템 구조

```
                Users
                   │
        ┌──────────┴──────────┐
        │                     │
     Customer              Staff/Admin
        │                     │
        └──────────┬──────────┘
                   │
            Next.js Application
                   │
        ┌──────────┼──────────┐
        │          │          │
 Authentication Reservation Payment
        │          │          │
        └──────────┼──────────┘
                   │
              Supabase
        ┌──────────┼──────────┐
        │          │          │
      Database     Auth      Storage
```

---

# Architecture Principles

## Layer Separation

Presentation

↓

Application

↓

Domain

↓

Infrastructure

각 Layer는 자신의 역할만 수행한다.

---

## Single Source of Truth

회원정보

예약

상품

결제

권한

모든 데이터는 하나의 Source만 가진다.

중복 저장을 최소화한다.

---

## Feature First

기능 중심으로 개발한다.

예)

```
reservation/

member/

product/

staff/

dashboard/

auth/
```

---

## Stateless API

모든 API는 Stateless하게 설계한다.

Session은 Auth Layer에서만 관리한다.

---

# Organization Structure

```
Organization

└── Centers

     ├── Center A

     ├── Center B

     └── Center C
```

Organization은 여러 센터를 소유할 수 있다.

---

# Center Structure

센터는 독립적으로 운영된다.

센터별

- 회원
- 예약
- 직원
- 상품
- 권한

을 가진다.

---

# User Structure

```
Organization

↓

Center

↓

Staff

↓

Role
```

직원은 여러 센터에 소속될 수 있다.

예)

```
홍길동

서울센터 관리자

강남센터 일반직원

부산센터 읽기전용
```

---

# Member Structure

회원은 센터 단위로 관리된다.

회원은

예약

수강권

결제

메모

알림

을 가진다.

---

# Authentication

지원 예정

Email

Password

Kakao

Apple

Google

Naver

SMS

---

# Account Linking

하나의 사용자

↓

여러 로그인 제공자 연결

```
Account

├── Email

├── Kakao

├── Apple

├── Google

└── Naver
```

동일 사용자는

어떤 로그인 방식으로 로그인하더라도

같은 데이터를 사용한다.

---

# Apple Hide My Email

자동 병합 금지

Apple Relay Email은

기존 이메일과 자동 연결하지 않는다.

본인 인증 후 연결한다.

---

# Authorization

RBAC(Role Based Access Control)

사용자

↓

Role

↓

Permission

↓

Action

권한은

UI가 아니라

Server

RLS

RPC

에서 검사한다.

---

# Reservation Flow

회원 선택

↓

상품 선택

↓

예약 생성

↓

중복 예약 검사

↓

담당자 배정

↓

알림 발송

↓

Activity Log 기록

↓

완료

---

# Payment Flow

예약

↓

결제

↓

PG

↓

결제 성공

↓

수강권 차감

↓

영수증 생성

↓

Activity Log

---

# Notification Flow

이벤트 발생

↓

Notification Queue

↓

Push

↓

SMS

↓

Email

↓

In App Notification

---

# Dashboard Flow

Database

↓

Aggregation

↓

Statistics

↓

Dashboard Card

↓

Chart

↓

Drill Down

---

# Activity Log

모든 관리자 작업은

Activity Log를 남긴다.

예)

예약 생성

예약 취소

회원 추가

직원 추가

권한 변경

센터 생성

상품 수정

결제 환불

로그인 방식 연결

비밀번호 변경

관리자 초대

---

# Security Layer

모든 요청은

JWT

↓

Permission

↓

RLS

↓

RPC

↓

Database

순으로 검증한다.

---

# Session

Session은 사용자 단위가 아니라

Device 단위로 관리한다.

예)

iPhone

Mac

Windows

Android

Tablet

각각 독립 Session

---

# Device Management

사용자는

내 기기

화면에서

현재 로그인 중인 기기를 확인할 수 있다.

지원

현재 기기

최근 로그인

마지막 사용 시간

강제 로그아웃

모든 기기 로그아웃

---

# Password Reset

Email

↓

Verification

↓

Reset Token

↓

New Password

↓

All Session Invalid(Optional)

↓

Activity Log

---

# Multi Center

센터 간 데이터는

기본적으로 완전히 분리한다.

권한이 없는 센터 데이터는

절대 조회할 수 없다.

---

# Audit

모든 중요 작업은

감사 로그를 남긴다.

누가

언제

무엇을

왜

어디서(IP)

어떤 Device

---

# Future Expansion

향후 지원 예정

AI 추천 예약

키오스크

QR Check-in

Apple Watch

Beacon

NFC

POS 연동

회계 연동

CRM

마케팅 자동화

---

# Architecture Rules

새로운 기능은

기존 Layer를 깨뜨리지 않는다.

새로운 기능은

기존 API를 최대한 유지한다.

새로운 기능은

Migration으로 추가한다.

Drop Table 금지

Hard Delete 금지

---

# Definition of Done

Architecture 변경 시

반드시

Architecture 문서

ERD

Graphify

Decision Log

Change Log

를 함께 업데이트한다.
