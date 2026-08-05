# 환경 일치 검증 (Track 3, 2026-08-03)

CI에서는 당일예약 OFF·10분 취소 규칙이 모두 green인데, 실브라우저(Vercel Preview, PR #39)에서는
동작하지 않는다는 보고를 받고 진행한 환경 비교. **코드를 먼저 수정하지 않고 환경 차이부터
확인**하라는 지시에 따라 작성.

## 확인 결과 요약

| 항목 | 확인 가능 여부 | 결과 |
|---|---|---|
| 로컬 `.env.local`의 Supabase Project Ref | 가능(파일 직접 읽음) | `bxntqg***` (마스킹) |
| GitHub Actions Secrets가 가리키는 Project Ref | **불가능** — `gh secret list`는 이름/갱신일만 노출, 값은 GitHub이 절대 반환하지 않음(설계상 불가) | 확인 못 함 |
| CI 로그에 URL이 노출되는지 | 확인함 — 노출 안 됨(GitHub Actions가 알려진 시크릿 값을 로그에서 자동 마스킹) | 확인 못 함 |
| Vercel Preview/Production 환경변수 | **불가능** — Vercel CLI/API 접근 도구가 이 세션에 없음 | 확인 못 함 |
| 로컬 브랜치/커밋 | 가능 | `feature/qa-batch-nav-reservation-notifications`, 최신 커밋 `1736406`(이후 이 배치에서 추가 커밋 진행 중) |
| PR #39 Preview가 배포한 커밋 | 가능(간접) — Vercel 배포는 push할 때마다 그 커밋 기준으로 자동 갱신되고, CI의 "Vercel: pass" 체크가 정확히 그 시점 커밋에 연결됨 | 매 push마다 최신 커밋과 함께 갱신 확인됨 |
| 각 환경의 `reserve_class()`/`cancel_reservation()`/`calc_deadline()` 정의 버전 | **불가능** — 어느 환경에서도 DB에 직접 접속할 도구/자격 증명이 없음(서비스 롤 키는 GitHub Secrets에만 있고 로컬에는 없음, `psql`/Supabase CLI 미설치) | 확인 못 함 |

## 결론

**Postgres 함수(`reserve_class`/`cancel_reservation`/`calc_deadline`)는 DB 안에 저장되며 Vercel
배포와 완전히 독립적입니다** — Vercel이 어떤 커밋을 배포하든, 클라이언트 코드가 호출하는
RPC 이름과 파라미터가 같다면 실제 실행되는 함수 본문은 오직 "그 RPC 호출이 도달하는 Supabase
프로젝트"에 달려 있습니다. 따라서 실브라우저 실패의 가장 유력한 원인은 다음 중 하나입니다:

1. **Vercel Preview 환경변수의 `NEXT_PUBLIC_SUPABASE_URL`이 CI/로컬과 다른 프로젝트를 가리킴**
   (예: 예전에 만든 스테이징/테스트 프로젝트, 혹은 오타). `docs/WORKFLOW.md`가 이미
   "vercel.json과 .vercel/이 없어 GitHub-Vercel 연결 여부와 배포 브랜치는 확인 필요"라고
   명시적으로 경고해둔 지점과 정확히 일치합니다.
2. Vercel Preview는 같은 프로젝트를 가리키지만, **사용자가 QA한 시점이 이번 SQL 적용
   이전이었을 가능성**(Preview URL을 새로고침 없이 오래 열어둔 브라우저 탭 등).
3. (가능성 낮음) Anon key는 같은데 RLS 정책이 요청 출처(origin)에 따라 다르게 동작 —
   Supabase RLS는 요청 출처를 구분하지 않으므로 이 가능성은 사실상 배제됩니다.

## 사용자가 직접 확인해야 하는 부분 (제가 도구로 볼 수 없는 영역)

1. Vercel 대시보드 → 해당 프로젝트(`booking-app`) → **Settings → Environment Variables**
2. 화면 상단의 환경 필터를 **Preview**로 두고 `NEXT_PUBLIC_SUPABASE_URL` 값을 확인
3. 같은 화면에서 필터를 **Production**으로 바꿔 같은 변수를 다시 확인
4. 두 값의 `https://`와 `.supabase.co` 사이 프로젝트 참조 문자열이 이 문서 상단의
   `bxntqg***`와 정확히 일치하는지 비교(값 전체를 저에게 붙여넣지 않으셔도 됩니다 —
   앞 6자리만 비교해도 충분합니다)
5. 값이 다르면: 그 Preview 배포가 SQL이 적용되지 않은(또는 아예 다른) Supabase 프로젝트를
   보고 있었던 것이 확정 원인입니다 — 코드 수정 불필요, Vercel 환경변수를 올바른 프로젝트로
   맞추기만 하면 됩니다(이 변경은 Vercel 설정 변경이라 사용자 승인이 필요한 영역입니다).
6. 값이 같으면: 실제 UI→RPC 호출 인자와 반환 에러를 실브라우저 개발자도구 Network 탭에서
   직접 추적해야 합니다(다음 단계로 별도 안내 가능).

## 참고: 왜 저는 이 이상 확인할 수 없는지

- 이 세션에는 Vercel API 토큰/CLI가 설치·인증되어 있지 않습니다.
- GitHub Actions Secrets는 설계상 값을 절대 다시 읽을 수 없습니다(쓰기 전용) — 이름과
  마지막 갱신일만 `gh secret list`로 조회 가능합니다.
- 로컬 `.env.test.local`이 없어 CI가 실제로 쓰는 통합 테스트 계정으로 로컬에서 직접 DB에
  접속해 함수 정의를 조회할 수도 없습니다.
