# PROJECT_OVERVIEW

> 이 문서는 현재 저장소의 코드(`package.json`, `app/`, `lib/`, `*.sql`, `README.md`)를 분석해 작성했습니다.
> 최종 갱신: 2026-07-27 (커밋 `155fda1` 기준)

## 1. 프로젝트 목적

센터(필라테스샵·헬스장·발레학원 등 운동시설)를 위한 **통합 예약·회원 관리 앱**입니다.
하나의 코드베이스 안에 "회원(고객) 모드"와 "매니저(센터 운영) 모드"가 함께 존재하며,
한 계정(`accounts`)이 회원 역할과 매니저 역할을 동시에 가질 수 있습니다(마이페이지에서 모드 전환).

`README.md`에 명시된 기획 참고 서비스: 하이파이브, 스튜디오메이트, 다짐의 장점을 참고해 설계.

### 개발 철학

이 프로젝트는 단순히 예약 기능을 만드는 것이 아니라

회원이

생각하지 않아도

예약 → 결제 → 수강

까지 자연스럽게 이어지는 UX를 만드는 것을 목표로 한다.

항상

- UX 우선
- 클릭 최소화
- 유지보수 가능한 구조
- 확장 가능한 구조

를 기준으로 개발한다.

## 2. 주요 사용자

세 부류의 사용자가 하나의 앱을 공유합니다.

| 사용자 유형 | 설명 | 진입 화면 |
|---|---|---|
| **일반 회원(고객)** | 센터를 찾아 수업을 예약하고 수강권/상품을 구매하는 최종 사용자 | `/`, `/reservation`, `/mypage` 등 |
| **매니저/강사(센터 운영진)** | 특정 센터에 소속되어 예약·회원·매출·수업 등을 관리 (`manager_centers` 테이블로 연결) | `/manager/*` |
| **플랫폼 운영자(우리 서비스 운영진)** | `accounts.is_platform_admin = true`인 소수 계정. 센터 가입 승인/반려, 카테고리·배너 관리 | `/admin/*` |

한 계정 안에서 회원(`profiles`)과 매니저(`manager_centers`) 역할이 공존할 수 있고,
매니저 내부에서도 센터별로 오너/매니저/강사 등 역할과 세부 권한이 다시 나뉩니다(`center_roles`, `permissions`).

## 3. 핵심 기능

- **예약**: 달력 기반 수업 예약, 수강권/상품 사용, 대기자 명단(취소 시 자동 승격), 노쇼 처리, 그룹/프라이빗 수업 구분
- **수강권(멤버십)**: 횟수권/기간권, 구매, 프로필 간 공유, 요일반 자동예약, 자동연장, 정지
- **결제/매출**: 분할결제(카드·현금·계좌이체·포인트), 미수금, 지출 기록, 매출 리포트 (실제 PG 연동은 없음 — [REQUIREMENTS.md](./REQUIREMENTS.md) 참고)
- **포인트**: 적립/사용 내역 관리 (⚠ 매출용/후기용 테이블이 분리되어 있음 — 확인 필요, [DATABASE.md](./DATABASE.md) 1-3절)
- **후기**: 별점·사진 후기, 센터 답변
- **공지사항**: 매니저 작성(서식·사진 포함) → 회원 열람
- **알림**: 실시간 팝업 + 누적 알림함 (회원/관리자 각각), 예약 리마인드·수강권 만료 알림(정기 실행 필요)
- **1:1 문의**: 회원 ↔ 센터 실시간 채팅(Supabase Realtime)
- **진도 관리**: 회원별 기술 습득 진도 기록(주로 스포츠 계열 센터 대상)
- **회원 관리**: 등급, 상태(이용중/만료/휴면), 메모, 주소, 출석
- **스태프/권한 관리**: 역할 생성, 역할별 권한 카탈로그(`permissions`), 개인별 권한 오버라이드 — 서버(RLS/DB 함수)에서 실제로 강제되지만, 화면에서 버튼/메뉴를 숨기는 데는 쓰이지 않음(확인됨, [ROUTES.md](./ROUTES.md) 3절)
- **플랫폼 관리**: 센터 가입 승인/반려, 종목(카테고리) 관리, 홈 배너 관리
- 스키마에는 있으나 실제 화면이 없는 기능(락커 배정, 수업별 복수 강사 배정, 수강권 양도, 전자계약서, 커뮤니티, 대회정보, 스태프 급여 등)은
  이 목록에서 제외했습니다 — 전체 목록은 [DATABASE.md](./DATABASE.md) 1-8절, [TODO.md](./TODO.md) 참고

## 4. 현재 기술 스택

`package.json` 기준:

| 영역 | 기술 |
|---|---|
| 프레임워크 | Next.js 16.2.10 (App Router, Turbopack 빌드) |
| 언어 | TypeScript 5 (strict 모드) |
| UI 라이브러리 | React 19.2.4 / React DOM 19.2.4 |
| 백엔드/DB | Supabase (`@supabase/supabase-js` ^2.110.5) — Postgres, Auth, Storage, Realtime |
| 스타일 | 순수 CSS (`app/globals.css`). Tailwind(`tailwindcss`, `@tailwindcss/postcss`)는 의존성·`postcss.config.mjs` 설정은 있지만 `globals.css`에 `@import "tailwindcss"`가 없어 **실제로는 적용되지 않는 것으로 확인됨** — `app/layout.tsx`의 일부 클래스(`flex flex-col` 등)는 죽은 클래스일 가능성, [TODO.md](./TODO.md) 참고 |
| 린트 | ESLint 9 + `eslint-config-next` |
| API 방식 | 별도 REST/GraphQL API 서버 없음. 클라이언트(브라우저)에서 `lib/*.ts`를 통해 Supabase에 직접 접근 (RLS로 보호) |

배포 대상은 명시되어 있지 않음(Vercel 등 특정 플랫폼 설정 파일 없음).

## 5. 전체 폴더 구조

```
booking-app/
├── app/                        # Next.js App Router 화면
│   ├── layout.tsx              # 루트 레이아웃 (전역 인증 가드는 없음 — 페이지별 체크)
│   ├── page.tsx                # 홈 (센터 목록/검색 진입)
│   ├── components/             # 공용 컴포넌트
│   │   ├── BottomNav.tsx       # 회원 모드 하단 네비게이션
│   │   ├── ManagerNav.tsx      # 매니저 모드 하단 네비게이션
│   │   ├── InquiryChat.tsx     # 1:1 문의 채팅 위젯
│   │   ├── NotificationToaster.tsx  # 실시간 알림 팝업
│   │   ├── MapPreview.tsx
│   │   └── Loading.tsx
│   ├── admin/                  # 플랫폼 운영자 화면 (센터 승인, 카테고리, 배너)
│   ├── manager/                # 매니저(센터 운영) 화면 20여 개 하위 라우트
│   ├── center/[id]/            # 센터 상세 (회원용)
│   ├── reservation/            # 예약 캘린더 (회원용)
│   ├── checkout/, cart/, purchases/   # 구매/결제 관련 (회원용)
│   ├── mypage/, profiles/, settings/  # 마이페이지 계열 (회원용)
│   ├── my-reservations/, notifications/, inquiries/, search/, category/[label]/, login/
│   └── globals.css
├── lib/                         # 데이터 로직 (Supabase 호출 전용, API 서버 없음)
│   ├── supabaseClient.ts       # Supabase 클라이언트 초기화
│   ├── admin.ts / manager.ts / roles.ts        # 플랫폼/매니저 권한
│   ├── reservations.ts / classes.ts            # 예약·수업 (최대 규모 모듈, 807줄)
│   ├── members.ts / mypage.ts / profiles.ts    # 회원 데이터
│   ├── sales.ts / orders.ts / passes.ts        # 결제·주문·수강권
│   ├── reviews.ts / announcements.ts / notifications.ts / inquiries.ts / progress.ts
│   ├── center.ts / rooms.ts / holidays.ts / operator.ts / settings.ts / cart.ts / home.ts
│   └── storage.ts              # Supabase Storage 업로드 헬퍼
├── *.sql                        # DB 스키마/마이그레이션 (루트에 60개 이상, 순서 실행 필요)
│   ├── schema.sql               # 기본 테이블/RLS/헬퍼 함수 (최초 1회)
│   ├── reservation_functions.sql# 예약 관련 DB 함수 (96개 정책 포함, 필수)
│   ├── auth_policies.sql        # 회원가입 시 INSERT를 여는 RLS
│   ├── add_*.sql                # 기능별 증분 마이그레이션
│   └── fix_*.sql                # 버그 수정용 마이그레이션
├── docs/                         # (본 문서 모음)
├── README.md / AUTH_SETUP.md / SETUP_INSTRUCTIONS.md / TEST_CHECKLIST*.md
├── package.json / tsconfig.json / next.config.ts / postcss.config.mjs
└── .env.local                   # NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY (커밋 금지)
```

---

# AI 개발 환경

본 프로젝트는 AI 협업을 전제로 개발한다.

| 도구 | 역할 |
|------|------|
| ChatGPT | 기획, UX 검토, 리뷰, 우선순위 |
| Claude Code | 구현 및 리팩토링 |
| NotebookLM | 프로젝트 문서 및 지식 관리 |
| Graphify | 구조 분석 |
| GitHub | 버전 관리 |
| Vercel | 배포 |

자세한 라우트별 설명은 [ROUTES.md](./ROUTES.md), 테이블 구조는 [DATABASE.md](./DATABASE.md)를 참고하세요.
