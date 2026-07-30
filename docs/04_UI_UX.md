# Booking App Master Specification

# 04. UI / UX Specification

Version : 1.0

---

# 목적

본 문서는 Booking App의 UI/UX 설계 원칙을 정의한다.

새로운 화면과 기능은 본 문서를 기준으로 디자인한다.

---

# Design Philosophy

Booking App은 다음 디자인 철학을 따른다.

Apple의 단순함

+

토스의 직관성

+

배달의민족의 친근함

+

Booking App만의 아이덴티티

---

# Goal

사용 설명서를 읽지 않아도 사용할 수 있는 UI

모든 주요 기능은

3번 이하의 터치로 접근 가능해야 한다.

---

# Design Principles

Simple

Consistent

Fast

Accessible

Predictable

Readable

---

# Supported Platforms

iOS

Android

Web

모든 플랫폼은 동일한 UX를 제공한다.

---

# Responsive

Mobile First

↓

Tablet

↓

Desktop

---

# Color System

Primary

Brand Color

Success

Warning

Danger

Background

Surface

Text

Border

Disabled

---

Brand Color는

프로젝트 전체에서 하나만 사용한다.

---

# Typography

Heading 1

Heading 2

Heading 3

Title

Body

Caption

Label

Button

---

글꼴은 시스템 폰트를 우선 사용한다.

iOS

SF Pro

Android

Roboto

Web

System Font

---

# Border Radius

Small

Medium

Large

Full

프로젝트 전체에서 동일한 Radius를 사용한다.

---

# Shadow

Level 1

Level 2

Level 3

과도한 Shadow 사용 금지

---

# Spacing

4

8

12

16

24

32

48

64

Spacing Scale을 통일한다.

---

# Icon

Outline Style 우선

Filled는 강조에만 사용

아이콘은 동일한 스타일을 유지한다.

---

# Button

Primary

Secondary

Outline

Ghost

Danger

Disabled

Loading

버튼 크기는

Small

Medium

Large

---

# Input

Text

Password

Phone

Number

Email

Search

Date

Textarea

Validation은 즉시 표시한다.

---

# Card

모든 주요 정보는 Card 형태를 기본으로 한다.

예약

회원

상품

공지

문의

결제

---

# Modal

중요 작업은 Modal 확인 후 진행

예)

삭제

환불

권한 변경

센터 삭제

---

# Bottom Sheet

Mobile에서는

가능하면 Bottom Sheet 사용

---

# Navigation

Bottom Navigation

5개 이하

관리자 화면은

Sidebar 사용 가능

---

# Empty State

데이터가 없을 경우

아이콘

제목

설명

CTA 버튼

을 제공한다.

---

# Loading

Skeleton UI 사용

Spinner 최소화

---

# Error

친절한 문구 제공

다시 시도 버튼 제공

---

# Toast

짧은 성공 메시지

예)

저장되었습니다.

예약되었습니다.

삭제되었습니다.

---

# Dialog

위험한 작업은

확인 Dialog 제공

---

# Accessibility

Touch Target

최소 44px

---

Contrast

WCAG 기준 준수

---

Screen Reader 지원

---

Keyboard Navigation 지원(Web)

---

# Dark Mode

지원

Color Token 기반

직접 색상을 사용하지 않는다.

---

# Animation

150ms ~ 300ms

과도한 Animation 금지

---

# Reservation Screen

필수 요소

날짜

시간

상품

담당자

회원

메모

예약 버튼

---

# Dashboard

Card

Chart

Summary

Quick Action

최근 활동

---

# Staff Screen

직원 목록

권한

센터

초대

상태

검색

---

# Member Screen

회원 검색

회원 상세

예약 내역

수강권

결제

메모

활동 로그

---

# Notification

Push

Badge

In-App Notification

지원

---

# Settings

계정

로그인 방법

비밀번호

세션 관리

기기 관리

알림

테마

언어

---

# Account Linking UI

사용자는

현재 연결된 로그인 방식을 확인할 수 있다.

지원

Email

Kakao

Apple

Google

Naver

연결

해제

마지막 로그인 방식 삭제 금지

---

# Session UI

현재 기기 표시

최근 로그인

기기 이름

OS

브라우저

강제 로그아웃

전체 로그아웃

---

# Permission UI

권한 없는 기능은

버튼을 숨기거나 비활성화한다.

단

최종 권한 검사는 서버에서 수행한다.

---

# Performance

첫 화면

2초 이내

화면 전환

300ms 이하

클릭 반응

100ms 이하

---

# Future Design

Dynamic Theme

Brand Theme

Season Theme

Custom Theme

지원 예정

---

# Design Rules

직접 색상 사용 금지

Design Token 사용

직접 Margin 남발 금지

Spacing System 사용

직접 Font Size 사용 금지

Typography Token 사용

---

# Definition of Done

새 화면 추가 시

Design Token 적용

Responsive 확인

Dark Mode 확인

Accessibility 확인

Loading 확인

Error 확인

Animation 확인

문서 업데이트
