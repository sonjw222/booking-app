# Booking App Master Specification

# 07. Activity Log Specification

Version : 1.0

---

# 목적

본 문서는 Booking App의 Activity Log(Audit Log) 정책을 정의한다.

모든 중요한 작업은 Activity Log를 남겨야 한다.

---

# 기본 원칙

Activity Log는 삭제하지 않는다.

기록은 수정하지 않는다.

모든 변경 사항은 추적 가능해야 한다.

---

# 기록 대상

예약

회원

결제

상품

직원

센터

권한

로그인

로그아웃

비밀번호

Account Linking

세션

공지사항

문의

설정

---

# 반드시 기록해야 하는 작업

회원 생성

회원 수정

회원 삭제

예약 생성

예약 수정

예약 취소

예약 완료

결제 성공

환불

상품 생성

상품 수정

상품 삭제

직원 초대

직원 삭제

권한 변경

센터 생성

센터 삭제

관리자 추가

관리자 삭제

비밀번호 변경

로그인

로그아웃

전체 로그아웃

기기 로그아웃

로그인 방식 연결

로그인 방식 해제

---

# Activity Log 테이블

id

actor_id

target_type

target_id

action

before_data

after_data

reason

center_id

organization_id

ip_address

device

browser

os

created_at

---

# Action 예시

CREATE

UPDATE

DELETE

LOGIN

LOGOUT

LINK_ACCOUNT

UNLINK_ACCOUNT

PASSWORD_CHANGE

PASSWORD_RESET

REFUND

CANCEL_RESERVATION

CHANGE_PERMISSION

CREATE_CENTER

DELETE_CENTER

---

# Target Type 예시

Member

Reservation

Payment

Product

Staff

Center

Organization

Notification

Session

Identity

Role

Permission

---

# Before / After

수정 작업은

변경 전

↓

변경 후

를 모두 저장한다.

---

# 개인정보 정책

비밀번호 저장 금지

OTP 저장 금지

Refresh Token 저장 금지

민감한 개인정보는 마스킹 처리

---

# 검색 기능

날짜

센터

관리자

작업 종류

회원

예약

IP

기기

기준으로 검색 가능해야 한다.

---

# 로그 조회 권한

Super Admin

전체 조회 가능

센터 관리자

자신의 센터만 조회 가능

일반 직원

조회 불가

---

# Account Linking 로그

연결

해제

실패

중복 연결 시도

Apple Relay Email 처리

모두 기록

---

# Session 로그

로그인

로그아웃

세션 만료

Refresh Token 재발급

강제 로그아웃

전체 로그아웃

---

# Security 이벤트

로그인 실패

권한 거부

Rate Limit

비정상 접근

중복 로그인

모두 기록

---

# IP 정보

IP

Country

Region

User Agent

Device

Browser

OS

저장

---

# 조회 화면

관리자는 다음 정보를 확인할 수 있다.

언제

누가

무엇을

왜

어디에서

결과

---

# 보존 정책

Activity Log는 기본적으로 삭제하지 않는다.

법적 또는 운영 정책에 따라 보관 기간을 설정할 수 있다.

---

# 성능

검색 인덱스 적용

Pagination 적용

필터 지원

CSV 내보내기 지원(향후)

---

# 알림 연동

중요 이벤트 발생 시 관리자에게 알림 가능

예)

권한 변경

환불

센터 삭제

관리자 추가

---

# 테스트

모든 중요 작업 후

Activity Log 생성 여부를 테스트한다.

---

# Definition of Done

새로운 기능 추가 시

Activity Log 대상 여부 검토

로그 생성 구현

조회 권한 검토

테스트 작성

문서 업데이트

Decision Log 업데이트

Change Log 업데이트
