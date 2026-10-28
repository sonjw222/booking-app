# 관리자 QA 결과 — 이슈 #238(페이지네이션 실환경) · #239(전 액션·역할별 실브라우저)

실행일 2026-10-28(로컬 시계, 파일명은 요청 일정에 맞춰 20261030). 브랜치 `qa/admin-238-239`(기준 `origin/main` f0df513). **운영·공유 DEV 에 쓰지 않았다**(DEV 는 CLI 읽기 전용 SELECT 1회). 모든 데이터 변경은 로컬 일회용 Supabase 스택에서만 했다.

## #238 — 관리자 센터 페이지네이션 실제 Supabase QA: **BLOCKED(실환경) / PASS(격리 환경)**

| 구분 | 결과 | 근거 |
|---|---|---|
| 공유 DEV 읽기 전용 재확인(2026-10-28, `supabase db query` SELECT) | 센터 8(승인 6·대기 2), `admin_list_centers_page(text,text,integer,timestamptz,uuid)`·`admin_list_centers(text)` 존재, `authenticated` 실행 가능·`anon` 불가, `is_platform_admin` 계정 **0** | `dev-readonly-check.json` |
| 실환경 브라우저 QA(플랫폼 관리자 로그인, 상태별 31건 이상) | **BLOCKED** — 플랫폼 관리자 계정 없음, 센터 8개뿐(<31). 계정·데이터를 만들지 않았다 | 위 + 이슈 전제 |
| 러너 자격 없을 때 | 9개 모두 **BLOCKED**, 요약 `INCOMPLETE`, 종료 코드 2(PASS 로 오인 불가) | `runner-238-BLOCKED-noadmin.log` |
| 격리 스택 + 실제 Supabase Auth 로그인 + 같은 러너(`npm run test:e2e:admin-pagination`) | ON(`NEXT_PUBLIC_ADMIN_CENTER_PAGINATION=true`) **PASS 9 / FAIL 0 / BLOCKED 0**, OFF **PASS 5 / FAIL 0 / BLOCKED 4**(ON 전용 항목이라 OFF 에서 BLOCKED 가 정상 — 러너가 의도적으로 INCOMPLETE 표기) | `runner-238-isolated-full.log` |
| 포함 검증 | 대기 31(같은 `created_at` 동률 5건)·승인 31·반려 61 에서 30/31 경계, 전 페이지 서버 id ↔ DOM id 일치(중복·누락 없음), 검색 debounce·응답 역전·빈 결과·탭 전환·네트워크 오류, ON/OFF RPC 이름 일치 | 같은 로그 |
| 단위 | `adminCenter*`·`adminPagination*` 8개 파일 56 테스트 통과 | vitest |

격리 fixture 는 `scripts/isolated/adminQa/seedAdminPagination.mjs`(격리 가드 통과 시에만 실행). **이슈 #238 은 닫을 수 없다**: 실환경(공유 DEV 또는 승인 대상) 플랫폼 관리자 로그인 QA 가 남아 있다.

## #239 — 관리자 전 액션·역할별 실브라우저 QA 매트릭스: **PASS(범위 내 54/54), 일부 항목은 BLOCKED/N/A**

- 실제 **Chromium**(Playwright 1.62, Desktop Chrome 1280×900, 모바일 폭 에뮬레이션 1건)로 로컬 격리 스택(Auth·PostgREST·Edge Functions)에 대해 실행. 두 번 연속 실행 모두 54/54(플레이크 없음).
- 전체 표(자동 생성): `adminqa/MATRIX_AUTO.md`, 원본 결과 `adminqa/results.json`, 스크린샷 `adminqa/screenshots/`(69장), 실행 로그 `adminqa/run-1.log`.
- 실행: `ISO_ENV_FILE=<env> scripts/isolated/adminQa/run.sh`(앱 서버는 격리 env 로 `npm run dev`). 스펙은 `tests/admin-qa/`(기본 CI 의 `tests/e2e` 밖 — 수동 실행).

| 역할 | 액션 | 결과 |
|---|---|---|
| 센터 오너 | 수업 생성·수정·삭제, 일정 복사(미리보기→확인) | PASS |
| 센터 오너 | 수강권 지급·연장(+30일)·상품(대여품) 지급 | PASS |
| 센터 오너 | 수강권 **환불** | **N/A** — 관리자 화면에 환불 처리 컨트롤이 없다(회원 본인 환불/PG API 경로, `docs/23_Admin_Feature_Audit.md` E). 실결제 환불은 금지 범위라 미실행. 컨트롤 0개임을 테스트로 고정 |
| 센터 오너 | 주문 발급(확정·발급)·취소 | PASS |
| 센터 오너 | 쿠폰 생성·지급, 공지 작성·수정, 후기 답변 | PASS |
| 센터 오너 | 알림톡 발송 UI(수신자→템플릿→발송) | PASS — 외부 호스트 요청 0건. 앱 기본 제공자가 mock 이라 알리고 호출 자체가 없고, `send-alimtalk` 요청은 가로채기 모킹도 걸어 두었다. `NEXT_PUBLIC_MESSAGE_PROVIDER=alimtalk` 실서비스 경로(Edge→알리고)는 외부 자격증명이 없어 실행하지 않았다(서버 권한 검사만 직접 호출로 확인) |
| 센터 오너 | 역할별 권한 편집·직원 역할 지정 | PASS |
| 제한 직원(조회 전용 역할) | 메뉴 노출, 주문·후기·공지·직원 화면의 쓰기 컨트롤 없음 | PASS |
| 제한 직원 | UI 우회 쓰기 시도 11건(운영 설정·센터 정보·룸·회원·결제·상품 수정·판매 정지·수강권 지급/연장 RPC·수업·공지·쿠폰·후기 답변·역할 지정·권한 부여) | 전부 서버 거부(403/RLS 0행/RPC 예외), DB 값 불변. 404(없는 함수)로 거부된 것처럼 보이는 항목이 없는지도 검사 |
| 제한 직원 | 알림톡 직접 발송(`send-alimtalk`) | **FAIL → 수정 → PASS**(아래 F1) |
| 플랫폼 관리자 | `/admin`·centers·banners·categories·marketing·reviews·settlement·subscription-plans·subscriptions 순회(읽기 전용) | PASS(페이지 오류 0) |
| 센터 오너·일반 회원 | `/admin/centers`·`/admin/settlement` 접근 | PASS(접근 거부 안내, 목록 없음) |
| 접근성·키보드 | 로그인 키보드 조작, 수업 시트 Escape 닫기, 권한 체크박스 이름, 폼 컨트롤 이름 | PASS(수정 후) — F2 |
| 모바일 | 390px 에뮬레이션 11개 화면 가로 넘침·오류 0 | PASS(에뮬레이션). **실기기 iOS/Android 는 BLOCKED**(이 환경 불가) |

### 정책 결정 대기 항목(이 QA 의 범위 밖 — 별도 이슈 필요 시 분리)
프라이빗 시간 단위 범위, 후기 삭제 후 재작성 보상은 미검증. "후기 답변 전용 권한 키"는 현재 카탈로그에 `facility.review.reply` 가 있고, 이 키가 없는 제한 직원에게 답변 버튼이 없고 서버도 거부함을 확인했다(PASS) — 이슈 본문의 해당 항목은 이미 반영된 것으로 보인다.

## 발견·수정한 결함(FAIL → 수정 → 재검증)

| # | 결함 | 재현(수정 전) | 수정 | 재검증 |
|---|---|---|---|---|
| F1 | **권한 없는 직원이 알림톡/SMS(유료 발송)를 직접 호출로 보낼 수 있음** — `send-alimtalk` 이 "센터 활성 매니저" 만 확인(메뉴만 `message.alimtalk.view` 로 가림) | 제한 직원 JWT 로 `send-alimtalk` 호출 → 403 이 아니라 **HTTP 502 "알리고 프록시가 아직 연동되지 않았어요"**(= 권한 검사 통과, 연동돼 있으면 실제 발송). 회원 목록의 '알림톡 발송' 버튼과 발송 화면도 권한 없이 노출 | `supabase/functions/send-alimtalk/index.ts` `isAuthorizedCaller`: 호출자 JWT 로 `has_permission(centerId,'message.alimtalk.view')` 확인(플랫폼 관리자·service_role 은 기존대로 통과). 회원 목록 버튼·발송 화면도 같은 권한으로 숨김/안내 | 제한 직원 403·UI 진입점 없음, 오너는 권한 검사 통과(502 까지만). `tests/unit/sendAlimtalkPermission.test.ts` 정적 회귀 + `06`·`05` 스펙 |
| F2 | 관리자 폼 접근성: 이름 없는 조작 요소 — 수업 등록 시트의 스위치 7종·오전/오후/시/분 select 6개, 쿠폰 날짜 입력 2개, 공지 제목(placeholder 만) | `09-a11y` 수정 전 실행: 수업 등록 시트 10개·쿠폰 2개·공지 1개 검출 | 스위치에 `role="switch"`·`aria-checked`·`aria-label`, `AmPmTimeInput` 에 `label`(시작/종료) 기반 `aria-label`, 쿠폰 날짜·공지 제목 `aria-label` | `09-a11y-keyboard` 통과(0개) |
| F3 | 회원 상세 시트의 '회원 상태' 칩이 수강권 지급 직후 지급 전 값('만료')으로 남음(새로고침해야 '활성') | `02` 수정 전 관찰: 지급 3초 뒤 상세 칩 `만료`, DB `center_members.status=active` | `app/manager/members/page.tsx` handleGrant: 목록 재로딩 뒤 열려 있는 상세의 회원 객체를 새 목록 값으로 교체 | `02` 에 '활성'·'만료 아님' 단언 추가, 통과 |

## 남은 한계·후속
- 이 앱의 다른 화면 스위치(운영 설정·상품·알림 설정 등 ~20곳)도 같은 이름 없는 `button.switch` 패턴이다 — 이번엔 시험한 관리자 폼(수업 등록/수정)만 고쳤다. `docs/TODO.md` 후속으로 기록.
- `/manager/alimtalk/*` 다른 하위 화면(규칙·템플릿·설정)은 화면 자체의 권한 가드가 없다(서버 RLS/함수가 막음) — 후속.
- 직접 URL 로 열 수 있는 `/manager/sales`(제한 직원)는 0원 데이터만 보여 준다(서버가 데이터를 가림). 데이터 노출은 없지만 "권한 없음" 안내가 낫다 — 후속(저우선).
- SQL 실행 필요: **NO**(이번 수정은 앱 코드 + Edge Function 코드. Edge Function 은 **배포가 필요**하며 이 작업에서는 배포하지 않았다 — `supabase functions deploy send-alimtalk`, 사용자 승인 사항).
