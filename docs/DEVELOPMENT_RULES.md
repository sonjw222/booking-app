# DEVELOPMENT_RULES

이 프로젝트는 여러 AI 도구/작업자가 시차를 두고 함께 유지보수합니다.
아래 규칙은 코드 일관성과 실서비스 안정성을 지키기 위한 최소 기준이며,
새로 합류하는 도구/작업자는 작업 시작 전 반드시 이 문서를 읽어야 합니다.

## 1. TypeScript에서 `any` 사용 금지

- 새로 작성하거나 수정하는 코드에서 `any`를 사용하지 않습니다. 구체적인 타입을 정의하거나,
  타입을 모를 때는 `unknown` + 타입 가드를 사용하세요.
- `catch (e: any)` 패턴도 금지 대상입니다. `catch (e) { const msg = e instanceof Error ? e.message : "..." }` 형태를 사용하세요.
- **현재 상태(참고용)**: 이 규칙 도입 이전에 작성된 코드에 `any`가 약 243곳(54개 파일)에 남아 있습니다
  (대부분 `catch (e: any)` 형태). 기존 코드를 건드리는 김에 점진적으로 제거하는 것은 권장하지만,
  관련 없는 파일까지 찾아다니며 리팩터링하지는 마세요(범위 외 변경 최소화 원칙과 충돌).
- `tsconfig.json`은 `strict: true`이지만 `noImplicitAny`를 별도로 더 엄격하게 강제하는 린트 규칙은 없으므로,
  이 규칙은 도구/사람이 직접 지켜야 합니다.

## 2. 수정 후 `npm run build` 필수

- 코드를 수정했으면 커밋하거나 "완료"라고 보고하기 전에 반드시 `npm run build`를 실행해 성공을 확인합니다.
- 이 프로젝트는 Turbopack 빌드 과정에서 TypeScript 타입체크와 Next.js 프리렌더 검증(예: `useSearchParams()`의 `Suspense` 누락)을 함께 수행하므로,
  `tsc --noEmit`만으로는 부족합니다. `npm run build`가 표준 검증 명령입니다.
- 빌드가 실패하면 원인을 근본적으로 고치고, 타입 오류를 `as any`나 `// @ts-ignore`로 덮어 우회하지 않습니다.
- UI를 바꾼 경우 가능하면 `npm run dev`로 실제 화면에서도 확인하세요(빌드 성공이 기능 동작을 보장하지 않음).

## 3. 환경변수는 커밋 금지

- `.env.local`에는 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`가 들어 있으며 `.gitignore`의 `.env*` 패턴으로 이미 제외되어 있습니다.
- `git add` 전에는 항상 `git status`로 `.env*` 파일이 스테이징되지 않았는지 확인하세요.
- 새로운 환경변수가 필요해지면 `.env.local`에 추가하고, 값이 아닌 **키 이름과 설명만** README나 `.env.local.example`에 기록합니다
  (현재 저장소에는 `.env.local.example`이 없으므로, 환경변수를 추가한다면 이 파일을 만들어 팀/도구 간 공유하는 것을 권장합니다).
- Supabase anon key는 공개 키(`NEXT_PUBLIC_`)이지만, 이후 service_role key 등 비공개 키를 다루게 되면 절대 클라이언트 코드나 저장소에 두지 않습니다.

## 4. 작업 전 `git status` 확인

- 어떤 파일을 수정하기 전에 `git status`로 현재 작업 트리 상태(다른 도구/사람이 남긴 미커밋 변경)를 확인합니다.
- 낯선 변경이 있으면 먼저 그 내용을 파악하고, 임의로 되돌리거나 덮어쓰지 않습니다.
- 파괴적 명령(`git reset --hard`, `git checkout -- .`, `git clean -f` 등)은 사용자 동의 없이 실행하지 않습니다.

## 5. 기능별 작은 커밋 사용

- 하나의 커밋은 하나의 논리적 변경 단위(버그 수정 1건, 기능 1개, 리팩터링 1건)로 유지합니다.
- 관련 없는 변경(예: 오타 수정 + 새 기능 + 포맷팅)을 한 커밋에 섞지 않습니다.
- 커밋 메시지는 "무엇을 왜" 바꿨는지 한두 문장으로 설명합니다. (예: `Fix sales product type error`처럼 구체적으로)
- SQL 마이그레이션과 그 마이그레이션을 사용하는 프론트엔드 코드는 함께 커밋해도 되지만, 서로 무관한 기능끼리는 분리합니다.

## 6. 데이터베이스 변경 시 SQL 파일 추가

- 이 프로젝트는 마이그레이션 도구(Prisma/Drizzle 등) 없이 **루트의 `*.sql` 파일을 순서대로 수동 실행**하는 방식입니다([DATABASE.md](./DATABASE.md) 참고).
- 테이블/컬럼/RLS 정책을 바꿔야 하면:
  1. 기존 `schema.sql`을 직접 고치지 말고, `add_<기능명>.sql` 또는 `fix_<문제>.sql` 형태의 **새 파일**을 추가합니다.
  2. 파일 상단에 `-- ============` 구분선 + 목적을 설명하는 한글 주석을 남깁니다(기존 파일들의 관례).
  3. 새 테이블을 만들면 반드시 `alter table ... enable row level security;`와 해당 정책을 같은 파일에 포함합니다.
  4. RLS 헬퍼 함수(`my_account_id()`, `my_profile_ids()`, `is_platform_admin()`)를 재사용하고, 정책 안에서 다시 호출되는 새 함수를 만들 때는 `security definer`로 선언해 무한 재귀를 피합니다([DATABASE.md](./DATABASE.md) 4절 참고).
  5. 이 문서(`docs/DATABASE.md`)의 테이블/SQL 파일 목록도 함께 갱신합니다.
- README의 "핵심 순서"(schema → reservation_functions → 이후 add/fix)를 벗어나는 의존성이 생기면 README에도 실행 순서를 명시합니다.

## 7. 기존 기능을 깨뜨리지 않도록 작업

- 이 앱은 API 서버 없이 프론트엔드가 Supabase를 직접 호출하므로, **RLS 정책 변경이 곧 접근 권한 변경**입니다. RLS를 고칠 때는 관련된 다른 역할(회원/매니저/오너/플랫폼운영자)의 접근이 막히지 않는지 함께 검토하세요.
- `lib/*.ts`의 함수 시그니처(파라미터/반환 타입)를 바꾸면 그 함수를 호출하는 모든 `app/**/page.tsx`를 찾아 함께 수정하고 `npm run build`로 확인합니다.
- 결제·예약처럼 상태 전이가 있는 도메인(`payments.status`, `orders.status`, `reservations.status`, `memberships.status`)을 다룰 때는 기존에 정의된 값(enum-like CHECK 제약)만 사용하고, 새 상태값이 필요하면 스키마의 CHECK 제약도 함께 갱신합니다.
- 실제 결제(PG) 연동, 소셜 로그인(네이버) 등 **의도적으로 미구현 상태인 기능**([REQUIREMENTS.md](./REQUIREMENTS.md) 참고)을 그럴듯하게 보이도록 가짜로 동작시키는 코드는 추가하지 않습니다. 미구현임을 사용자에게 명확히 안내하는 현재 방식을 유지하세요.
- 기존 사용자에게 노출되는 한국어 문구(에러 메시지, 안내 문구)의 톤(반말 아닌 존댓말, "~해요" 톤)을 유지합니다.
