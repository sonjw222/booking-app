# Booking App

센터(스튜디오/체육관 등) 예약·회원 관리 앱. Next.js + Supabase 기반.

회원 모드와 관리자(센터 운영) 모드가 한 앱에 있으며, 예약, 수강권/포인트, 후기,
공지사항, 알림, 1:1 문의 기능을 제공합니다.

## 기술 스택

- **Next.js 16** (App Router, TypeScript)
- **React 19**
- **Supabase** (Postgres + Auth + Storage + Realtime)
- 스타일: 순수 CSS (`app/globals.css`, 테마 변수 기반)

## 시작하기

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경변수 설정

`.env.local.example`을 복사해 `.env.local`을 만들고 값을 채웁니다.

```bash
cp .env.local.example .env.local
```

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

값은 Supabase 대시보드 → Settings → API 에서 확인합니다.

### 3. 데이터베이스 설정 (Supabase SQL Editor)

기본 스키마부터 순서대로 실행합니다. 핵심 순서는 다음과 같습니다.

1. `schema.sql` — 기본 테이블/RLS/헬퍼 함수
2. `reservation_functions.sql` — 예약 관련 함수
3. 그 외 `add_*.sql`, `fix_*.sql` — 기능별 마이그레이션

최근 추가된 기능은 아래 순서를 반드시 지켜 실행하세요 (뒤가 앞의 함수에 의존).

1. `add_announcements.sql` (공지사항)
2. `add_notifications.sql` (알림 시스템)
3. `add_notification_triggers.sql` (예약/취소/노쇼 등 알림 트리거)
4. `add_inquiries.sql` (1:1 문의 채팅)

### 4. Realtime 활성화

Supabase 대시보드에서 Realtime을 켜고, 위 SQL이 `notifications` /
`inquiry_messages` 테이블을 publication에 추가하는지 확인합니다.
(실시간 알림 팝업과 1:1 채팅에 필요)

### 5. 정기 알림

예약 3일 전/당일, 수강권 만료·소진 재등록 알림은 매일 1회 실행이 필요합니다.
`add_notification_scheduler.sql`을 실행하면 Supabase의 `pg_cron`으로 매일 KST 오전 9시에
자동 실행되도록 등록됩니다(무료 플랜 포함, 외부 서비스 불필요).

수동으로 한 번 실행해보고 싶다면:

```sql
select notify_upcoming_reservations();
select notify_expiring_passes();
```

### 6. 개발 서버 실행

```bash
npm run dev
```

http://localhost:3000

## 테스트

처음 이 프로젝트를 받았다면 아래 순서 그대로 실행하면 됩니다.

```bash
# 1. 의존성 설치 (위 "시작하기" 1번과 동일하면 생략)
npm install

# 2. 통합 테스트용 환경변수 템플릿 복사
cp .env.test.local.example .env.test.local

# 3. .env.test.local을 열어 값을 채우기
#    (Supabase URL/키, 테스트 계정 A/B, 테스트 센터/상품 id — 각 변수 용도는 tests/README.md 참고)

# 4. 단위 테스트 (Supabase 불필요, 설정 없이 바로 실행됨)
npm run test

# 5. 통합 테스트 (2~3번 설정이 끝난 뒤 실행)
npm run test:integration
```

`npm run test:all`은 4~5번을 순서대로 한 번에 실행합니다. 통합 테스트에 필요한 환경변수
전체 목록(용도별 설명)과 운영 DB 오발동 방지 방법은 [tests/README.md](./tests/README.md)를
참고하세요.

## 주요 기능

- **예약**: 달력 기반 수업 예약, 수강권/상품 사용, 대기자, 노쇼 처리
- **수강권·포인트**: 구매, 공유, 후기 작성 시 포인트 적립/사용
- **후기**: 별점·사진 후기, 서식 있는 센터 답변
- **공지사항**: 매니저가 서식·사진 포함 공지 작성 → 회원 열람
- **알림**: 실시간 팝업 + 누적 알림함 (회원/관리자 각각)
- **1:1 문의**: 회원 ↔ 센터 실시간 채팅 (글/사진)

## 폴더 구조

```
app/            화면 (App Router)
  components/   공용 컴포넌트 (네비게이션, 채팅, 알림 등)
  manager/      관리자 모드 화면
  ...           회원 모드 화면
lib/            데이터 로직 (Supabase 호출)
*.sql           데이터베이스 마이그레이션
```
