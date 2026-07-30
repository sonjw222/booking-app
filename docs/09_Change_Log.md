# Booking App Master Specification

# 09. Change Log

Version : 1.0

---

# 목적

본 문서는 Booking App의 변경 사항을 버전별로 기록한다.

Git Commit은 개발 기록이고,

Change Log는 릴리스 기록이다.

---

# 작성 원칙

모든 사용자에게 영향을 주는 변경 사항은 반드시 기록한다.

---

# Change Categories

Added

Changed

Improved

Fixed

Deprecated

Removed

Security

Performance

Documentation

---

# Version Format

MAJOR.MINOR.PATCH

예)

1.0.0

1.1.0

1.1.1

2.0.0

---

# Version Rules

MAJOR

호환되지 않는 큰 변경

예)

Multi Center

Payment 구조 변경

---

MINOR

새 기능 추가

예)

Apple Login 추가

예약 기능 추가

---

PATCH

버그 수정

UI 수정

성능 개선

---

# Release Template

Version

Release Date

Author

Summary

Added

Changed

Fixed

Security

Performance

Migration

Known Issues

Related Documents

---

# Version 1.0.0

Status

Planning

---

Added

Project Principles

Architecture

Database

API

UI/UX

Security

Testing

Activity Log

Decision Log

---

Changed

-

---

Fixed

-

---

Security

Authentication 정책 수립

RLS 정책 수립

Account Linking 정책 수립

---

Performance

기본 성능 기준 정의

---

Migration

초기 Migration

---

Known Issues

없음

---

# Future Releases

## Version 1.1.0

예정

예약 개선

관리자 기능 개선

대시보드 개선

---

## Version 1.2.0

예정

QR 체크인

출석 관리

Push Notification 개선

---

## Version 2.0.0

예정

CRM

마케팅

AI 추천

프랜차이즈 기능

---

# 기록 대상

새 기능

기능 변경

삭제

버그 수정

성능 개선

보안 수정

Migration

API 변경

DB 변경

Design System 변경

---

# Release Checklist

Change Log 작성

Migration 확인

API 문서 확인

Decision Log 확인

Activity Log 확인

Graphify 업데이트

Claude Rule 확인

---

# Commit vs Change Log

Commit

개발 과정 기록

---

Change Log

사용자 관점의 변경 사항 기록

---

# Related Documents

00_Project_Principles.md

01_Architecture.md

02_Database.md

03_API.md

04_UI_UX.md

05_Security.md

06_Testing.md

07_Activity_Log.md

08_Decision_Log.md

10_Claude_Rules.md

---

# Definition of Done

기능 배포 전

Change Log 작성

버전 증가

관련 문서 업데이트

릴리스 체크리스트 확인
