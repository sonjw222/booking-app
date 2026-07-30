# Booking App Master Specification

# 13. Design System

Version : 1.0

---

# 목적

Booking App의 모든 화면은 동일한 디자인 시스템을 사용한다.

새로운 화면은 본 문서를 기준으로 구현한다.

---

# Design Philosophy

Apple의 단순함

+

빠른 사용성

+

직관적인 정보 전달

+

Booking App만의 브랜드 아이덴티티

---

# Brand Identity

키워드

Simple

Professional

Modern

Friendly

Reliable

Fast

---

# Design Tokens

절대 직접 색상을 사용하지 않는다.

모든 색상은 Token을 사용한다.

---

# Color Palette

Primary

Primary Light

Primary Dark

Secondary

Success

Warning

Danger

Info

---

Neutral

Gray 50

Gray 100

Gray 200

Gray 300

Gray 400

Gray 500

Gray 600

Gray 700

Gray 800

Gray 900

---

Background

Background

Surface

Card

Overlay

---

Text

Primary

Secondary

Tertiary

Disabled

Inverse

---

Border

Default

Strong

Focus

Disabled

---

# Typography

Display

H1

H2

H3

Title

Subtitle

Body Large

Body

Body Small

Caption

Label

Button

---

Font Weight

Regular

Medium

SemiBold

Bold

---

# Radius

XS

Small

Medium

Large

XL

Full

---

# Spacing

4

8

12

16

20

24

32

40

48

64

80

96

---

# Shadow

Level 1

Level 2

Level 3

Level 4

---

# Icon

Outline 기본

Filled는 강조만 사용

한 가지 스타일만 유지

---

# Button

Primary

Secondary

Outline

Ghost

Danger

Text

Icon

Loading

Disabled

---

Button Size

XS

Small

Medium

Large

XL

---

# Input

Text

Password

Phone

Number

Email

Date

Time

Search

Textarea

OTP

---

Input State

Default

Focus

Error

Success

Disabled

Read Only

---

# Card

Information

Reservation

Payment

Member

Dashboard

Product

Announcement

---

# Modal

Confirmation

Alert

Form

Danger

---

# Bottom Sheet

Mobile 기본

Desktop에서는 Dialog 사용

---

# Navigation

Bottom Navigation

Sidebar

Top Navigation

Breadcrumb

---

# List

Simple List

Card List

Grouped List

Virtual List

---

# Table

Sortable

Filterable

Pagination

Responsive

---

# Calendar

Month

Week

Day

Timeline

예약 상태별 색상 구분

---

# Badge

Primary

Success

Warning

Danger

Info

Neutral

---

# Chip

Filter

Status

Category

---

# Avatar

Image

Initial

Icon

---

# Loading

Skeleton

Spinner

Progress

---

# Empty State

Illustration

Title

Description

CTA

---

# Toast

Success

Error

Warning

Info

---

# Animation

Fast

150ms

Normal

250ms

Slow

350ms

Ease In

Ease Out

Ease In Out

---

# Grid

4 Columns

8 Columns

12 Columns

반응형 Grid 사용

---

# Breakpoints

Mobile

Tablet

Desktop

Wide Desktop

---

# Accessibility

Touch Target

44px 이상

Keyboard Navigation

지원

Screen Reader

지원

WCAG AA 준수

---

# Dark Mode

지원

Color Token 기반

직접 색상 사용 금지

---

# Theme

Default Theme

향후 지원

Brand Theme

Season Theme

Custom Theme

---

# Component Rules

Component는

재사용 가능해야 한다.

단일 책임 원칙을 따른다.

Variant를 적극 활용한다.

---

# Naming Rules

Button

Input

Card

Modal

Toast

Badge

Chip

Avatar

Calendar

Dialog

---

# Performance

애니메이션 최소화

Layout Shift 최소화

Lazy Rendering 사용

---

# Definition of Done

새 Component 추가 시

Design Token 적용

Responsive 확인

Dark Mode 확인

Accessibility 확인

문서 업데이트
