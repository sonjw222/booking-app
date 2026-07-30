# Booking App Master Specification

# 17. API Examples

Version : 1.0

---

# 목적

본 문서는 Booking App의 API 요청(Request) 및 응답(Response) 예시를 정의한다.

모든 API는 본 문서의 형식을 따른다.

---

# 공통 Response

## Success

HTTP 200

{
  "success": true,
  "data": {}
}

---

## Error

HTTP 400

{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "잘못된 요청입니다."
  }
}

---

# Authentication

## Login

POST /api/v1/auth/login

Request

{
  "email": "user@example.com",
  "password": "password123"
}

Response

{
  "success": true,
  "data": {
    "accessToken": "...",
    "refreshToken": "...",
    "user": {}
  }
}

---

## Logout

POST /api/v1/auth/logout

Response

{
  "success": true
}

---

# Member

## 회원 조회

GET /api/v1/members

Response

{
  "success": true,
  "data": [
    {
      "id": "...",
      "name": "홍길동",
      "phone": "01012345678"
    }
  ]
}

---

## 회원 생성

POST /api/v1/members

Request

{
  "name":"홍길동",
  "phone":"01012345678"
}

Response

{
  "success":true,
  "data":{
      "id":"..."
  }
}

---

# Reservation

## 예약 생성

POST /api/v1/reservations

Request

{
  "memberId":"...",
  "productId":"...",
  "staffId":"...",
  "reservationDate":"2026-08-01T14:00:00"
}

Response

{
  "success":true,
  "data":{
      "reservationId":"..."
  }
}

---

## 예약 취소

PATCH /api/v1/reservations/{id}/cancel

Request

{
    "reason":"고객 요청"
}

---

# Product

## 상품 생성

POST /api/v1/products

Request

{
    "name":"10회 PT",
    "price":500000,
    "count":10
}

---

# Payment

## 결제

POST /api/v1/payments

Request

{
    "reservationId":"...",
    "method":"card",
    "amount":50000
}

---

## 환불

POST /api/v1/refunds

Request

{
    "paymentId":"...",
    "reason":"예약 취소"
}

---

# Staff

## 직원 초대

POST /api/v1/staff/invite

Request

{
    "email":"staff@example.com",
    "role":"manager"
}

---

# Account Linking

## 로그인 방식 조회

GET /api/v1/account/identities

Response

{
    "success":true,
    "data":[
        {
            "provider":"google",
            "linked":true
        },
        {
            "provider":"apple",
            "linked":false
        }
    ]
}

---

## 로그인 방식 연결

POST /api/v1/account/link

Request

{
    "provider":"google"
}

---

## 로그인 방식 해제

DELETE /api/v1/account/unlink

Request

{
    "provider":"google"
}

---

# Session

## 현재 로그인 기기

GET /api/v1/sessions

---

## 특정 기기 로그아웃

DELETE /api/v1/sessions/{id}

---

## 전체 로그아웃

DELETE /api/v1/sessions/all

---

# Notification

## 알림 조회

GET /api/v1/notifications

---

## 읽음 처리

PATCH /api/v1/notifications/read

---

# Error Codes

VALIDATION_ERROR

UNAUTHORIZED

FORBIDDEN

NOT_FOUND

CONFLICT

RATE_LIMIT

SERVER_ERROR

---

# Pagination

Request

?page=1&limit=20

Response

{
  "success":true,
  "data":[...],
  "pagination":{
      "page":1,
      "limit":20,
      "total":180,
      "totalPages":9
  }
}

---

# Filtering

GET /members?status=active

GET /reservations?date=2026-08-01

GET /products?type=pt

---

# Sorting

?sort=createdAt

?
```
