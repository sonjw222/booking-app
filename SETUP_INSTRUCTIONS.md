# 시작하기 - WSL(우분투) 터미널에서 순서대로 실행

## 1. 프로젝트 생성
```bash
cd ~
npx create-next-app@latest booking-app
```
질문이 뜨면 이렇게 선택하세요:
- TypeScript: **Yes**
- ESLint: Yes
- Tailwind CSS: **No** (우리는 일반 CSS로 갈 거예요)
- `src/` directory: No
- App Router: **Yes**
- import alias 커스터마이즈: No (기본값 그대로 Enter)

## 2. 프로젝트 폴더로 이동 + Supabase 라이브러리 설치
```bash
cd booking-app
npm install @supabase/supabase-js
```

## 3. 이 zip 안의 파일들을 복사
이 안내와 함께 온 파일들을 아래 위치에 그대로 덮어쓰기/추가하세요:

| 이 zip 안의 파일 | 프로젝트 안에서의 위치 |
|---|---|
| `app/globals.css` | `booking-app/app/globals.css` (덮어쓰기) |
| `app/page.tsx` | `booking-app/app/page.tsx` (덮어쓰기) |
| `lib/supabaseClient.ts` | `booking-app/lib/supabaseClient.ts` (새로 생성) |
| `.env.local.example` | `booking-app/.env.local` 이름으로 복사 |

VS Code에서 WSL 창을 열고 (`code .`) 파일 탐색기로 드래그해서 옮기면 편해요.

## 4. Supabase 키 채워넣기
`.env.local` 파일을 열어서 두 값을 채우세요. Supabase 대시보드 → 프로젝트 → Settings → API 메뉴에서 확인할 수 있어요.

```
NEXT_PUBLIC_SUPABASE_URL=여기에_Project_URL_붙여넣기
NEXT_PUBLIC_SUPABASE_ANON_KEY=여기에_anon_public_key_붙여넣기
```

## 5. 실행
```bash
npm run dev
```
터미널에 나오는 `http://localhost:3000` 을 브라우저에서 열면 홈 화면이 보여요.

---

## 지금 이 코드가 하는 일 / 안 하는 일
- **하는 일**: 우리가 만든 홈 화면 목업을 실제 React 컴포넌트로 옮겨놓음 (정적 화면, 테마 전환 버튼 동작)
- **아직 안 하는 일**: 실제 DB에서 클래스 목록 가져오기, 로그인, 예약 처리 — 이건 다음 단계에서 하나씩 붙일 거예요

## 막히면
- `npm run dev` 했는데 에러 나면 에러 메시지 그대로 저한테 붙여넣어주세요
- Supabase 키가 뭔지 모르겠으면 대시보드 스크린샷 보여주셔도 돼요
