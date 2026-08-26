# DEVELOPMENT_RULES

## 1. 문서 메타데이터

| 항목 | 값 |
|---|---|
| 문서 목적 | 현재 저장소 구조에 맞는 구현·검증·Git·문서화 규칙 |
| 최종 검증일 | 2026-07-28 |
| 기술 기준 | Next.js 16.2.10, React 19.2.4, TypeScript 5 strict, Supabase JS 2.110.5 |
| 적용 대상 | `app/`, `lib/`, 루트 SQL, 프로젝트 설정과 `docs/` |
| 상위 규칙 | [CLAUDE.md](../CLAUDE.md) |
| 작업 절차 | [AI_PLAYBOOK.md](./AI_PLAYBOOK.md) · [WORKFLOW.md](./WORKFLOW.md) |

이 문서는 일반적인 웹 개발 모범 사례를 나열하지 않습니다. 현재 코드·설정에서 확인된 구조와 이 프로젝트의 반복된 오류를 기준으로 반드시 지켜야 할 규칙만 정의합니다.

## 2. 작업 시작과 범위

1. 수정 전 `git status`를 확인합니다.
2. 사용자가 지정한 파일·기능 범위만 변경합니다.
3. 기존 미커밋 변경은 다른 작업자의 작업일 수 있으므로 되돌리거나 덮어쓰지 않습니다.
4. 관련 `page.tsx`, 호출하는 `lib/*.ts`, 테이블·RPC SQL과 다음 문서를 함께 확인합니다.
   - 기능 상태: [REQUIREMENTS.md](./REQUIREMENTS.md)
   - 데이터와 RLS: [DATABASE.md](./DATABASE.md)
   - 실제 화면과 접근 처리: [ROUTES.md](./ROUTES.md)
5. 문서와 코드가 다르면 실제 코드를 기준으로 판단하고 문서를 갱신합니다.
6. 요청과 무관한 이름 변경, 포맷팅, 파일 이동, 대규모 리팩터링을 섞지 않습니다.
7. 파괴적 명령과 데이터 변경은 대상과 영향을 확인하고 사용자 승인을 받습니다.

## 3. Next.js와 React

### 3-1. 현재 구조

- Next.js 16 App Router를 사용합니다.
- 실제 화면은 `app/**/page.tsx`에 있으며 현재 41개입니다.
- 페이지와 다수의 공용 컴포넌트는 `"use client"` 기반입니다.
- 별도 Next.js API Route나 독립 API 서버 없이 브라우저가 `lib/*.ts`를 통해 Supabase를 직접 호출합니다.
- `app/layout.tsx`에는 전역 로그인·권한 가드가 없습니다.
- `next.config.ts`에는 현재 별도 옵션이 없습니다.

### 3-2. 라우트와 클라이언트 컴포넌트

- 새 화면은 App Router 디렉터리 규칙을 따르고 실제 `page.tsx`가 생길 때만 [ROUTES.md](./ROUTES.md)에 추가합니다.
- 브라우저 상태, `localStorage`, Supabase 클라이언트, React hook을 사용하는 파일에는 `"use client"` 경계를 유지합니다.
- `useSearchParams()`를 사용하는 페이지는 Next.js 16 prerender 요구사항에 맞게 `Suspense` 경계를 둡니다.
  - 이 누락으로 여러 페이지가 동시에 build 실패한 이력이 있습니다.
- 동적 route parameter는 현재 방식대로 `useParams()` 또는 페이지 구조에 맞는 Next.js API를 사용하고 문자열 존재 여부를 확인합니다.
- 공용 화면 이동 규칙이 이미 있으면 재사용합니다. 예약 복귀 URL은 `lib/reservationNav.ts`가 기준입니다.
- 같은 query parameter 이름을 여러 화면에서 조립할 때 한쪽만 변경하지 말고 송신·수신 화면을 함께 확인합니다.
- 확인창은 네이티브 `confirm()`을 쓰지 않고 `await globalThis.appConfirm(message)`(`app/components/AppConfirmProvider.tsx`, 앱 루트 레이아웃에 이미 마운트됨)를 씁니다 — 네이티브 `confirm()`은 브라우저 기본 스타일로 떠서 검게 깨진 것처럼 보입니다(2026-08-25 사용자 리포트로 15개 파일·21곳에서 재발견, 전면 마이그레이션함). 단순 알림(선택지 없이 확인만)이 필요하면 `alert()` 대신 해당 화면의 기존 toast/error 상태를 재사용하거나 새로 추가합니다.

### 3-3. 스타일

- 실제 전역 스타일 원본은 `app/globals.css`입니다.
- Tailwind 패키지와 PostCSS plugin은 설치되어 있지만 `globals.css`에 Tailwind import가 없어 utility class 생성은 확인되지 않았습니다.
- Tailwind가 활성화됐다고 가정해 새 utility class만으로 UI를 구현하지 않습니다.
- 새 스타일은 현재 CSS class와 inline style 관례를 확인해 일관되게 작성합니다.
- Tailwind를 활성화하거나 제거하는 작업은 별도 범위로 다룹니다.

## 4. TypeScript

### 4-1. 타입 기준

- `tsconfig.json`의 `strict: true`, `noEmit: true`, `moduleResolution: "bundler"` 설정을 유지합니다.
- 새 코드와 수정하는 코드에는 `any`를 추가하지 않습니다.
- 외부 값이나 catch 오류는 `unknown`으로 받고 타입 가드로 좁힙니다.

```ts
catch (error) {
  const message = error instanceof Error ? error.message : "처리 중 오류가 발생했어요";
}
```

- DB row, 화면 state, 함수 parameter와 return type은 실제 select 컬럼과 일치하게 정의합니다.
- Supabase가 반환하는 nullable 값은 타입과 UI에서 모두 처리합니다.
- 타입 오류를 `as any`, `// @ts-ignore`, 과도한 단언으로 숨기지 않습니다.

### 4-2. 기존 `any`

- 현재 `app/`·`lib/`에는 `: any`가 약 241건, 54개 파일에 남아 있습니다.
- 이 값들은 규칙 도입 전 코드이므로 이번 작업과 관련된 위치는 안전하게 제거할 수 있습니다.
- 관련 없는 파일까지 일괄 수정하지 않습니다.
- 함수 시그니처를 바꾸면 `rg`로 모든 호출자를 찾아 함께 수정합니다.

### 4-3. 상태값과 문자열 union

- `orders`, `payments`, `reservations`, `memberships`, `classes`의 상태는 SQL CHECK와 코드의 string union을 일치시킵니다.
- 새 상태를 UI 타입에만 추가하거나 SQL에만 추가하지 않습니다.
- 상태 label과 필터를 바꿀 때 목록·상세·집계·RPC의 비교 조건을 함께 검색합니다.

## 5. Supabase 사용

### 5-1. 클라이언트와 데이터 모듈

- 공용 Supabase client는 `lib/supabaseClient.ts`의 `supabase`를 사용합니다.
- 화면의 데이터 로직은 가능한 한 도메인별 `lib/*.ts`에 둡니다.
- 페이지가 새 테이블을 직접 호출하기 전에 같은 도메인의 기존 `lib` 함수가 있는지 확인합니다.
- 기존 함수의 select 컬럼, 반환 변환, 오류 문구를 유지하면서 확장합니다.
- Supabase error를 무시하지 말고 사용자 메시지 또는 호출자에게 전달합니다.
- `.single()`과 `.maybeSingle()`은 행 존재가 보장되는지에 따라 기존 의도를 확인해서 사용합니다.

### 5-2. 브라우저 직접 접근의 의미

- 이 프로젝트에는 데이터 접근을 대신 보호하는 서버 API가 없습니다.
- 클라이언트에서 버튼을 숨기는 것은 보안이 아닙니다.
- 회원·매니저·오너·플랫폼 운영자의 최종 read/write 제한은 RLS와 RPC에서 강제해야 합니다.
- 공개 조회가 필요한 데이터와 개인정보·센터 운영 데이터를 구분합니다.
- service role key가 필요한 로직을 클라이언트에 추가하지 않습니다.

### 5-3. Realtime과 Storage

- 알림과 문의 Realtime은 운영 Supabase publication 설정이 필요하므로 코드만으로 완료 처리하지 않습니다.
- subscription을 만든 컴포넌트는 unmount 또는 대상 변경 시 기존 channel을 정리합니다.
- 이미지와 사업자등록증은 기존 Storage helper와 bucket 정책을 사용합니다.
- `business-licenses`는 비공개 자료이므로 공개 URL 방식으로 바꾸지 않습니다.
- bucket이 운영 환경에 생성·설정됐다고 저장소만 보고 단정하지 않습니다.

## 6. SQL migration

### 6-1. 파일 작성

- 이 프로젝트는 Prisma·Drizzle 같은 migration 도구 없이 루트의 SQL 파일을 수동 적용합니다.
- 기존 `schema.sql`을 현재 변경용 migration처럼 직접 수정하지 않습니다.
- 기능 추가는 `add_<기능>.sql`, 오류 보정은 `fix_<문제>.sql` 새 파일로 작성합니다.
- 파일 상단에는 기존 관례대로 목적과 실행 전제, 영향 객체를 설명하는 주석을 둡니다.
- 새 테이블을 만들면 같은 파일에서 RLS를 활성화하고 필요한 policy를 정의합니다.
- 새 RPC가 앱에서 호출되면 필요한 execute 권한과 RLS 우회 범위를 확인합니다.

### 6-2. 기존 SQL 확인

- `schema.sql`만 현재 최종 스키마로 간주하지 않습니다.
- 관련 `add_*.sql`, `fix_*.sql`, `reservation_functions.sql`을 함께 확인합니다.
- `reserve_class`, `cancel_reservation`, `fulfill_order`, `manager_set_attendance`, `reserve_with_membership` 등은 여러 SQL 파일에서 `create or replace`된 이력이 있습니다.
- RPC를 수정하기 전 같은 함수명을 전체 SQL에서 검색하고 어느 정의를 최종본으로 삼는지 기록합니다.
- 저장소 파일 존재와 운영 Supabase 적용 상태를 구분합니다. 확인하지 못한 적용 상태는 **확인 필요**입니다.

### 6-3. 위험한 변경

다음 작업은 사용자 승인 없이 수행하지 않습니다.

- `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`
- `WHERE` 없는 `DELETE`·`UPDATE`
- 기존 RLS policy 제거 또는 접근 범위 확대
- 기존 상태값·CHECK 제약 삭제
- 타입 변경이나 대규모 데이터 백필
- 운영 데이터 초기화 스크립트 실행

`reset_test_data.sql`은 파괴적 테스트 스크립트이며 운영 DB에서 실행하지 않습니다.

## 7. 권한과 RLS

### 7-1. 역할

권한 검증 시 다음 역할을 구분합니다.

- 비로그인 사용자
- 일반 회원과 본인 프로필
- 센터 스태프
- 센터 매니저
- 센터 오너
- 플랫폼 운영자

한 계정은 회원과 매니저 역할을 동시에 가질 수 있고 여러 프로필·센터 소속을 가질 수 있습니다.

### 7-2. 권한 helper

- 기존 `my_account_id()`, `my_profile_ids()`, `my_managed_center_ids()`, `is_platform_admin()`, `has_permission()`을 우선 재사용합니다.
- RLS 안에서 다른 RLS 테이블을 다시 조회하는 helper는 재귀 위험을 확인합니다.
- `security definer` 함수는 필요한 최소 범위로 사용하고 `search_path`와 내부 권한 조건을 기존 안전한 함수와 비교합니다.
- 플랫폼 운영자 권한을 가입 또는 클라이언트 update로 획득할 수 있는 경로를 만들지 않습니다.

### 7-3. UI 가드와 서버 권한

- `fetchMyCenters()`와 `checkPlatformAdmin()`은 사용자 경험을 위한 클라이언트 가드입니다.
- 해당 함수가 없는 페이지도 있으므로 새 관리자 화면은 가드 누락 여부를 명시적으로 확인합니다.
- 매니저 세부 권한은 현재 대부분 UI를 숨기지 않고 서버에서만 거부합니다.
- UI에 권한 제어를 추가하더라도 RLS/RPC 검증을 제거하지 않습니다.
- 권한 오류는 원본 DB 오류만 노출하지 말고 사용자가 이해할 수 있는 기존 한국어 톤으로 처리합니다.

## 8. 데이터 무결성

### 8-1. 예약과 수강권

- 같은 프로필의 같은 수업 활성 예약 중복을 허용하지 않습니다.
- 수강권 잔여횟수는 음수가 될 수 없습니다.
- 예약, 수강권 차감, 취소 복구, 대기 승격처럼 함께 성공해야 하는 변경은 기존 RPC transaction 흐름을 유지합니다.
- 예약을 클라이언트의 여러 독립 update로 분해하지 않습니다.
- 자동예약과 수동예약이 수강권 요일·시간·수업명 조건을 다르게 해석하지 않도록 관련 RPC를 함께 확인합니다.
- 취소 마감 후 차감, 폐강, 출석·노쇼 상태 변경 시 횟수 복구가 중복되지 않는지 검증합니다.

### 8-2. 주문, 결제와 포인트

- `orders`의 주문 접수와 실제 PG 결제를 같은 상태로 표현하지 않습니다.
- `fulfill_order()`는 중복 발급과 중복 매출 기록을 막아야 합니다.
- 분할결제 합계, 미수금, 위약금과 환불 부호를 기존 매출 계산 방식에 맞춥니다.
- `point_transactions`와 `point_accounts`는 현재 이원화되어 있으므로 한쪽만 바꾸고 통합됐다고 가정하지 않습니다.
- 결제·환불·포인트 변경은 관련 원장과 사용자 표시 값이 함께 맞는지 확인합니다.

### 8-3. 스키마 변경과 기존 데이터

- `NOT NULL` 컬럼에는 기존 행을 위한 default 또는 backfill 계획이 필요합니다.
- FK를 추가하거나 바꿀 때 기존 orphan row 가능성을 확인합니다.
- 컬럼 이름·타입 변경은 select 문자열, TypeScript 타입, 화면 state와 RPC 본문을 함께 갱신합니다.
- 코드 미사용 테이블도 RPC·trigger·운영 도구가 사용할 수 있으므로 바로 삭제 대상으로 간주하지 않습니다.

## 9. UI 상태와 비동기 처리

모든 데이터 화면은 해당 흐름에 필요한 다음 상태를 처리합니다.

- 초기 loading
- 데이터 없음
- 사용자 입력 부족
- 로그인 필요
- 권한 없음
- 네트워크·Supabase 오류
- 저장·삭제·발급 등 처리 중 상태
- 성공 후 목록·상세의 재조회 또는 낙관적 갱신

추가 규칙:

- 비동기 버튼은 처리 중 중복 클릭을 막고 완료·실패 후 상태를 복구합니다.
- 화면에서 선택 대상이 바뀌면 이전 대상의 데이터와 오류를 초기화합니다.
- 빠른 수업·센터 전환처럼 요청이 겹칠 수 있는 화면은 요청 token, 취소 flag 또는 동일한 보호 패턴으로 오래된 응답을 무시합니다.
- effect의 subscription, timer와 자동 이동은 cleanup을 제공합니다.
- 빈 배열과 조회 실패를 같은 상태로 취급하지 않습니다.
- 실제 PG, 푸시, 네이버 로그인처럼 미완성 기능을 성공한 것처럼 보이게 하지 않습니다.
- 사용자 문구는 기존의 존댓말과 “~해요” 톤을 유지합니다.
- DB 원본 오류에 민감 정보나 내부 SQL이 포함될 수 있으면 그대로 사용자에게 노출하지 않습니다.

## 10. 로컬 검증

### 10-1. 표준 명령

코드 변경 후 완료 보고나 commit 전에 실행합니다.

```bash
npm run build
```

- build는 TypeScript 검사와 Next.js prerender 검증을 포함하는 현재 표준 게이트입니다.
- 실패하면 최초 원인을 수정하고 성공할 때까지 완료 처리하지 않습니다.
- UI 동작 변경은 가능한 경우 `npm run dev`로 실제 화면을 확인합니다.
- 자동화된 테스트 suite는 현재 저장소에서 확인되지 않으므로 수동 테스트 범위와 결과를 기록합니다.

### 10-2. lint 현재 상태

- `package.json`에는 `npm run lint`가 있지만 저장소에 ESLint config 파일이 없어 현재 즉시 실패합니다.
- lint 설정을 고치는 작업이 아니라면 이 실패를 기능 오류로 오인하지 않고 `npm run build`를 표준 타입·빌드 검증으로 사용합니다.
- 임의의 ESLint config를 이번 기능 변경에 함께 추가하지 않습니다.

### 10-3. 역할별 검증

- 공개 화면: 비로그인 조회
- 회원 화면: 비로그인, 대표·추가 프로필, 본인 데이터
- 매니저 화면: 소속 없음, 제한된 스태프, 오너, 다른 센터
- 플랫폼 화면: 운영자와 비운영자
- RLS 변경: 각 역할의 read·insert·update·delete
- 예약·결제 변경: 정상 상태와 중복·마감·실패 상태

운영 Supabase migration이나 외부 Provider를 확인하지 못했으면 그 검증을 통과했다고 기록하지 않습니다.

## 11. 환경변수

- 현재 클라이언트가 사용하는 키는 다음과 같습니다(`.env.local.example` 참고, 2026-08-19 기준).
  - 필수: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - 선택(비우면 해당 기능만 비활성/mock, 앱 자체는 정상 동작): `NEXT_PUBLIC_NAVER_CLIENT_ID`,
    `NEXT_PUBLIC_KAKAO_CLIENT_ID`(AUTH_SETUP.md), `NEXT_PUBLIC_PAYMENT_PROVIDER`,
    `NEXT_PUBLIC_PAYMENT_SCENARIO`(lib/payments/PaymentProviderFactory.ts),
    `NEXT_PUBLIC_VAPID_PUBLIC_KEY`(lib/webPush.ts)
- 값은 `.env.local`에 두며 `.gitignore`의 `.env*`로 제외됩니다.
- `git status`와 staging 전에 `.env*`, key, token, credential 포함 여부를 확인합니다.
- `NEXT_PUBLIC_` 값은 브라우저에 노출됩니다. 비밀값을 이 prefix로 추가하지 않습니다.
- Supabase service role key를 `app/`, `lib/` 클라이언트 코드에 두지 않습니다.
- 새 환경변수는 코드, 로컬, Vercel의 키 이름을 일치시키고 값이 아닌 키 이름·용도만 문서화합니다.
- `.env.local.example`(앱용)과 `.env.test.local.example`(통합 테스트용) 둘 다 값이 아닌
  키 이름·용도만 담습니다. 새 `process.env.NEXT_PUBLIC_*`를 추가하면 해당 파일에도 같이 반영합니다.
- Vercel 환경변수와 로컬 환경변수가 같다고 추측하지 않고 배포 시 별도 확인합니다.

## 12. Git

### 12-1. 작업 트리 보호

- 작업 전후 `git status`를 확인합니다.
- 다른 문서·코드의 기존 변경을 보존합니다.
- 사용자 승인 없이 `git reset --hard`, `git checkout -- .`, `git clean -f`를 사용하지 않습니다.
- 자동 포맷이나 생성 명령으로 요청 범위 밖 파일을 대량 변경하지 않습니다.

### 12-2. diff와 commit

- 완료 전 `git diff --check`로 whitespace 오류를 확인합니다.
- `git diff`와 `git status`를 읽고 변경 파일과 핵심 내용을 사용자에게 요약합니다.
- 하나의 commit에는 하나의 논리적 변경을 담습니다.
- SQL migration과 그 migration을 사용하는 코드·문서는 같은 논리적 변경으로 묶을 수 있습니다.
- commit 메시지는 무엇을 왜 바꿨는지 드러나게 작성합니다.
- 사용자가 “커밋하지 말라”고 하면 파일만 저장하고 작업 트리를 그대로 둡니다.
- push는 사용자가 명시적으로 요청한 경우에만 수행합니다.
- commit, push, Vercel 배포, Supabase 적용을 각각 별도 상태로 보고합니다.

## 13. 문서 갱신

변경 내용은 담당 문서 한 곳에 상세히 쓰고 다른 문서에서는 링크로 연결합니다.

| 변경 | 갱신 문서 |
|---|---|
| 기능 구현·미완성·확인 필요·운영 설정 필요 상태 | [REQUIREMENTS.md](./REQUIREMENTS.md) |
| 테이블·뷰·RPC·RLS·trigger·SQL | [DATABASE.md](./DATABASE.md) |
| 실제 `page.tsx`, 사용자 유형, 데이터 의존성, 권한 처리 | [ROUTES.md](./ROUTES.md) |
| 프로젝트 목적·기술 스택·큰 폴더 구조 | [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md) |
| 남은 작업과 우선순위 | [TODO.md](./TODO.md) |
| 완료된 변경과 날짜 | [CHANGELOG.md](./CHANGELOG.md) |
| AI 도구 책임과 구현 절차 | [AI_PLAYBOOK.md](./AI_PLAYBOOK.md) |
| 기획부터 배포 후 동기화까지의 단계 | [WORKFLOW.md](./WORKFLOW.md) |

문서 갱신 규칙:

1. 코드와 화면을 모두 확인한 경우에만 기능을 **구현됨**으로 표시합니다.
2. 운영 DB, OAuth, Realtime, pg_cron, Vercel 상태를 확인하지 못했으면 **확인 필요** 또는 **운영 설정 필요**로 기록합니다.
3. 새 route는 실제 `page.tsx`가 있을 때만 ROUTES에 추가합니다.
4. SQL에만 있는 기능을 실제 화면처럼 기록하지 않습니다.
5. 완료되지 않은 계획을 CHANGELOG에 완료 이력으로 쓰지 않습니다.
6. 이번 범위에서 해결하지 않은 문제는 TODO에 근거와 우선순위를 남깁니다.
7. 구조 변경이 있으면 Graphify 갱신 필요 여부를 확인하고 결과 또는 생략 이유를 기록합니다.

## 14. 완료 체크리스트

- [ ] 작업 전 Git 상태와 사용자 범위를 확인했다.
- [ ] 관련 화면·lib·SQL·문서를 직접 읽었다.
- [ ] Next.js client/Suspense 경계를 확인했다.
- [ ] 새 `any`, `@ts-ignore`, 불필요한 타입 단언을 추가하지 않았다.
- [ ] Supabase 오류와 nullable 데이터를 처리했다.
- [ ] RLS/RPC에서 모든 관련 역할의 권한을 검토했다.
- [ ] 예약·결제·수강권·포인트 무결성을 확인했다.
- [ ] loading·empty·error·busy·권한 상태를 처리했다.
- [ ] 환경변수와 비밀정보가 diff에 없다.
- [ ] 필요한 수동 테스트와 `npm run build`를 실행했다.
- [ ] 미실행 검증과 운영 설정 필요 사항을 기록했다.
- [ ] 관련 문서를 담당 범위에 맞게 갱신했다.
- [ ] `git diff --check`, `git diff`, `git status`를 확인했다.
- [ ] commit·push·배포·DB 적용 상태를 구분해 보고했다.
