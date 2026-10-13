# Preview 소셜 로그인 운영 도메인 이동 — 원인과 콘솔 설정 안내 (Issue #198, 2026-10-12)

## 원인
앱 코드는 이미 모든 redirect를 `window.location.origin`으로 계산한다(하드코딩 없음). Preview에서 mwhabit.com으로 가는 건 **Supabase Auth의 Redirect URL allowlist** 때문이다: `signInWithOAuth({ redirectTo })`의 redirectTo가 allowlist에 없으면 Supabase가 **Site URL(`https://mwhabit.com`)로 fallback**한다.

## 공급자별 영향
| 공급자 | 경로 | Preview 동작 | 필요 설정 |
|---|---|---|---|
| Google(웹) | Supabase `signInWithOAuth` | allowlist 미등록 시 운영 도메인으로 이동(본 이슈) | Supabase Redirect URLs에 Preview 패턴 추가 |
| Apple(웹) | Supabase `signInWithOAuth` | 동일 | 동일(Apple Return URL은 Supabase 콜백이라 변경 불필요) |
| Kakao | 커스텀 authorize + `/login/kakao-callback` | 운영 도메인으로 가지 않음. Redirect URI 미등록이면 카카오 오류 | 카카오 콘솔 Redirect URI에 Preview 콜백을 임시 추가 |
| Naver | 커스텀 authorize + `/login/naver-callback` | 동일 | 네이버 콘솔 Callback URL에 Preview 콜백을 임시 추가 |
| Google/Apple 네이티브 앱 | id token(`signInWithIdToken`) | redirect 없음, 영향 없음 | 없음 |

## 필요한 콘솔 설정 (코드/에이전트가 임의 변경하지 않음 — 담당자가 수행)
1. Supabase Dashboard → Authentication → URL Configuration → **Redirect URLs**에 추가:
   - `https://*-<vercel-team-slug>.vercel.app/**` (Vercel Preview 패턴; 팀 슬러그는 Vercel 프로젝트에서 확인)
   - 필요 시 특정 Preview: `https://<preview-host>.vercel.app/**`
   - **Site URL은 `https://mwhabit.com` 그대로 둔다**(운영·네이티브 영향 방지). 기존 운영 항목은 삭제하지 않는다.
2. Kakao/Naver는 QA할 Preview의 `https://<preview-host>/login/kakao-callback`, `/login/naver-callback`을 임시 추가하고 QA 후 제거한다. 운영 콜백은 건드리지 않는다.
3. `NEXT_PUBLIC_KAKAO_CLIENT_ID`, `NEXT_PUBLIC_NAVER_CLIENT_ID`가 Vercel Preview 환경에도 있는지 확인(값은 문서/코드에 적지 않는다).

보안 참고: 와일드카드는 팀 슬러그로 한정해 타인 소유 `*.vercel.app`이 매칭되지 않게 한다.

## Preview 검증 방법
1. 위 설정 후 Preview URL에서 `/login` → Google(웹 브라우저) 클릭 → 로그인 완료 후 주소창 호스트가 Preview 호스트인지 확인.
2. Kakao/Naver도 같은 방식으로 확인. 콜백 URL의 `state`가 없거나 다르면 "요청이 만료됐거나 올바르지 않아요"가 뜨는 것도 확인(CSRF 방어).
3. 운영(mwhabit.com)과 네이티브 앱 로그인은 변경이 없으므로 회귀 확인만 한다.

## SQL
필요 없음.
