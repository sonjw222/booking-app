# Booking App Master Specification

# 02. Database Specification

Version : 1.0

---

# 목적

본 문서는 Booking App의 데이터베이스 설계 원칙과 구조를 정의한다.

모든 테이블, 관계, 인덱스, RLS, Migration은 본 문서를 기준으로 구현한다.

---

# Database

Database : PostgreSQL

Provider : Supabase

Timezone : UTC

Application Timezone : Asia/Seoul

Encoding : UTF-8

---

# Database Principles

## Single Source of Truth

동일한 데이터는 하나의 테이블에서만 관리한다.

중복 컬럼을 만들지 않는다.

---

## UUID

모든 Primary Key는 UUID를 사용한다.

예)

id UUID PRIMARY KEY

---

## Timestamp

모든 테이블은 다음 컬럼을 가진다.

created_at

updated_at

deleted_at (Soft Delete)

---

## Soft Delete

Hard Delete는 사용하지 않는다.

삭제 시

deleted_at

을 기록한다.

---

# Organization Structure

```
Organization

↓

Centers

↓

Staff

↓

Members

↓

Reservations

↓

Payments
```

---

# Core Tables

## organizations

회사

브랜드

사업체

---

대표 컬럼

id

name

business_number

owner_id

created_at

updated_at

---

## centers

지점

센터

대표 컬럼

id

organization_id

name

phone

address

timezone

status

---

## center_members

직원

센터 소속

대표 컬럼

id

center_id

user_id

role

status

joined_at

---

## users

회원 계정

대표 컬럼

id

email

phone

name

birth

status

---

## account_identities

로그인 방식 관리

대표 컬럼

id

user_id

provider

provider_user_id

provider_email

verified

linked_at

---

Provider

email

kakao

apple

google

naver

---

## members

실제 고객

대표 컬럼

id

center_id

user_id(nullable)

name

phone

memo

status

---

회원은

비회원

회원가입 사용자

모두 지원한다.

---

## products

상품

수강권

이용권

PT

필라테스

요가

등

---

대표 컬럼

id

center_id

name

type

price

remaining_count

duration

---

## reservations

예약

대표 컬럼

id

center_id

member_id

product_id

staff_id

reservation_date

status

memo

---

예약 상태

Pending

Confirmed

Completed

Cancelled

No Show

---

## payments

결제

대표 컬럼

id

reservation_id

member_id

amount

method

status

pg_provider

---

결제 상태

Pending

Paid

Refunded

Failed

Cancelled

---

## notifications

알림

대표 컬럼

id

user_id

type

title

message

read_at

---

## activity_logs

관리자 감사 로그

대표 컬럼

id

actor_id

target_type

target_id

action

before

after

ip_address

device

created_at

---

# Relationships

organization

↓

centers

↓

members

↓

reservations

↓

payments

---

users

↓

account_identities

↓

sessions

---

center

↓

staff

↓

roles

↓

permissions

---

# Permission Tables

roles

permissions

role_permissions

user_roles

center_members

---

권한은

Role 기반으로 관리한다.

---

# Session Tables

sessions

refresh_tokens

login_history

trusted_devices

---

기기별 Session 관리

---

# Index Strategy

모든 Foreign Key는 Index를 생성한다.

예)

organization_id

center_id

member_id

reservation_id

staff_id

user_id

---

검색이 많은 컬럼도 Index 생성

phone

email

reservation_date

status

provider

---

# RLS

모든 Business Table은

RLS 활성화

---

예)

예약

회원

결제

상품

직원

공지

문의

알림

---

조회 권한

센터 권한 확인

↓

Role 확인

↓

Permission 확인

↓

조회 허용

---

# RPC

복잡한 비즈니스 로직은 RPC 사용

예)

예약 생성

예약 취소

환불

권한 변경

관리자 초대

Account Linking

---

# Migration Rules

Drop Table 금지

Drop Column 최소화

Rename보다 Add 선호

데이터 손실 금지

Migration은 항상 Rollback 가능해야 한다.

---

# Account Linking Rules

동일 사용자는

여러 로그인 방식을 연결할 수 있다.

Email

Kakao

Apple

Google

Naver

---

자동 병합 금지

반드시 본인 인증 후 연결

---

Apple Hide My Email

자동 연결 금지

---

# Audit Rules

다음 작업은 반드시 Activity Log 기록

회원 생성

회원 수정

회원 삭제

예약 생성

예약 변경

예약 취소

결제

환불

상품 수정

직원 추가

직원 삭제

권한 변경

센터 생성

센터 삭제

관리자 초대

로그인 방식 연결

비밀번호 변경

세션 종료

---

# Backup

자동 백업

Point In Time Recovery 사용

백업 테스트 정기 수행

---

# Performance Rules

N+1 Query 금지

SELECT * 지양

필요한 컬럼만 조회

Pagination 사용

Lazy Loading 적용

Index 활용

---

# Security Rules

Password 저장 금지

Password Hash만 저장

Refresh Token 암호화

민감정보 암호화

HTTPS 필수

JWT 검증

Rate Limit 적용

---

# Future Tables

향후 추가 예정

attendance

qr_checkin

crm

marketing

campaigns

gift_cards

coupon

review

ai_recommendations

---

# Definition of Done

새로운 테이블 추가 시

반드시

Migration 작성

RLS 작성

Index 작성

ERD 수정

Graphify 업데이트

Architecture 문서 업데이트

Decision Log 업데이트

Change Log 업데이트
