# Issue #274 Batch 2 — 의존값 변경 시 상태 초기화 QA (2026-11-25)

기준: main `bffe2e92`(`dpl_4PuzYzs91t2epDr8oESUhNr4YEGV`) → 브랜치 `refactor/react-hooks-state-reset-batch2-20261125`. 격리 로컬 Supabase(`mwhabit-reviewpath`) + `next build`/`start`. 실제 결제·주문·예약 생성 없음(QA 전후 orders/payments/reservations 0/0/0), 외부 호스트 차단, 공유 `mwhabit-isolated`·:3100·터널 미접촉. 정리 전 main 을 같은 환경에서 빌드해 같은 시나리오를 돌려 비교했다.

## 대상 15건 분석과 처리
(`react-hooks/set-state-in-effect` 70건 중 "의존값이 바뀌면 상태를 비우는" 패턴. 줄 번호는 main `bffe2e92`)

| # | 파일:줄 | effect 가 하던 일(초기화 이유·조건) | 방식 | 결과 |
|---|---|---|---|---|
| 1 | `useExpandableNavRail.ts:90` | rail 범위(768~1359px)를 벗어나면 펼침 해제 | `useResetOnChange([pathname, inRailRange])` 로 #2 와 통합 | 해결 |
| 2 | `useExpandableNavRail.ts:93` | 경로가 바뀌면 compact 복귀 | 〃(펼침은 범위 안에서만 가능 → "범위 진입" 초기화는 이미 접힌 상태에 대한 no-op) | 해결 |
| 3 | `CountPriceEditor.tsx:43` | 입력 중이 아닐 때 입력창 값을 실제 행 수(rowMax)에 맞춤 | **파생값**: 입력 중에만 `maxDraft` 를 두고 평소엔 `String(rowMax)` | 해결 |
| 4 | `MemberAddSheet.tsx:39` | 센터가 바뀌면 결과·검색어·진행 표시·오류 비움 | `useResetOnChange([centerId])`(상태) + 요청 무효화 ref 는 effect 유지. (이 컴포넌트는 부모가 `key={centerId}` 로도 재마운트하므로 입력값 보존 정책 변화 없음) | 해결 |
| 5 | `admin-assignments/page.tsx:84` | 목록·검색어가 바뀌면 "더 보기" 개수 초기화 | `useResetOnChange([logs, kw])` | 해결 |
| 6 | `classes/page.tsx:235` | 조회 조건(폼 열림·센터·날짜·시간)이 사라지면 일정 충돌 경고 비움 | `useResetOnChange([conflictCheckEnabled])` — true→false 로 바뀔 때만 비움(입력 변경으로 재조회하는 동안은 예전처럼 이전 경고 유지) | 해결 |
| 7 | `classes/page.tsx:352` | 센터가 없어지면 센터 설정 비움 | `useResetOnChange([activeCenterId])` | 해결 |
| 8 | `coupons/page.tsx:152` | 지급 검색 조건(센터·쿠폰·검색어)이 없어지면 결과 비움 | `useResetOnChange([issueSearchEnabled])` | 해결 |
| 9 | `membership-rules/page.tsx:110` | 센터가 바뀌면 수업 목록 비움 + 늦은 응답 판별 ref 갱신 | 상태는 `useResetOnChange([centerId])`, ref 는 렌더 밖 effect 한 곳(기존 단위 테스트 의도 유지) | 해결 |
| 10 | `membership-rules/page.tsx:264` | 회원 검색 조건이 없어지면 결과 비움 + 같은 effect 에서 "검색 중…" 을 동기로 켬 | 결과 비움은 `useResetOnChange([visSearchEnabled])`, "검색 중…" 은 **파생**(완료 키 ≠ 현재 검색 키(센터\|검색어)) | 해결(부수 개선: 150ms 안에 검색어를 지우면 "검색 중…" 이 영구히 남던 기존 문제 사라짐) |
| 11 | `manager/page.tsx:143` | 센터가 바뀌면 오늘 수업 비우고 로딩 표시 | `useResetOnChange([activeCenterId])` | 해결 |
| 12 | `search/page.tsx:127` | 검색어가 2자 미만이 되면 검색 상태(결과·진행·오류) 비움 | `useResetOnChange([queryTooShort])`, 늦은 응답을 버리는 ref 는 effect 유지 | 해결 |
| 13 | `checkout/page.tsx:208` | 상품이 쿠폰 적용 불가가 되면 쿠폰 목록 비움 | `useResetOnChange([couponsApplicable])`(적용 가능→불가 전환 시만; 가능한 상품끼리 바뀔 때는 새 응답까지 이전 목록 유지) | 해결(쿠폰 목록 표시 상태만, 결제·금액·주문 로직 변경 없음) |
| 14 | `reservation/page.tsx:319` | 날짜/프로필이 바뀌면 구매 가능 상품 캐시 비움 + 로딩 플래그·요청 id 갱신 | — | **보류(위험)** |
| 15 | `reservation/page.tsx:376` | 보유 상품 조회 조건이 없으면 비움 + 로딩 플래그 | — | **보류(위험)** |

### 보류 사유(14·15, 예약 화면)
두 effect 는 상태 초기화뿐 아니라 로딩 플래그(`setPassesLoading(true)`)·요청 id ref 증가(`++passesReqRef`, `purchasableReqRef.current++`)가 한 effect 안에 얽혀 있다. 상태 초기화만 렌더 중으로 옮기면(effect 는 커밋 이후) 그 사이에 늦게 도착한 이전 요청 응답이 초기화된 상태/로딩 플래그를 덮는 좁은 경쟁이 생길 수 있고, 로딩 플래그를 effect 밖에서 켤 수 없어 effect 에는 동기 setState 가 남는다. 예약 흐름(결제·예약 기능 변경 금지 범위에 인접)이라 임의로 진행하지 않았다. 권장: 결과를 요청 키와 함께 저장하는 파생 방식으로 **별도 PR**(예약 E2E 필요).

## 구조 변경 요약
`app/components/useResetOnChange.ts`(신규): 이전 deps 를 state 로 기억하고, 렌더 중 deps 가 달라지면(`Object.is`, useEffect 와 같은 비교) 같은 컴포넌트의 상태를 즉시 초기화(React 공식 패턴). 이전 값이 한 프레임도 커밋되지 않는다. onReset 은 자기 컴포넌트 setState 만, ref·타이머·네트워크는 effect 에 남긴다. 옵션 `runOnMount`(기본 꺼짐). 이 훅 단독으로는 `set-state-in-effect` 를 숨기는 장치가 아니다 — 초기화 시점을 effect(커밋 뒤)에서 렌더 중(커밋 전)으로 옮겨 이전 상태 노출을 없애는 것이 목적이다.
주의(이론상 좁은 경쟁): 렌더 중 초기화는 effect cleanup 의 `cancelled` 플래그 설정보다 먼저 일어난다. 따라서 "초기화 직후 ~ effect cleanup 사이(한 프레임 미만, 커밋과 passive effect 사이)"에 이전 요청의 응답이 도착하는 경우에만 이전 결과가 한 번 보일 수 있다 — 대부분 사용자 이벤트(타이핑·클릭)로 바뀌는 deps 라 passive effect 가 같은 태스크에서 동기 실행되어 창이 없고, 예전 구조는 오히려 이전 값이 항상 한 렌더 보였다. 예약 화면은 이 창과 로딩 플래그 때문에 보류했다.

## ESLint 측정 (`npx eslint .`, 전 → 후)
| 항목 | 전 | 후 |
|---|---|---|
| 전체 Error / Warning | 145 / 28 | **132 / 28** |
| `react-hooks/set-state-in-effect` | 70 | **57** |
| Batch 2 대상 15건 중 해결 | — | **13건** (예약 2건 보류) |
| 신규 오류·경고 / 다른 파일로 이동 | — | 0 / 0 (QA 스크립트의 미사용 변수 경고 1건은 즉시 제거) |
baseline(`scripts/lint/baseline.json`)은 `updateBaseline.mjs` 로 재생성만 했다(124 → 111 키, 145 → 132건, 증가 0, 설정 완화 없음). `lint:strict` = 160 problems(132 E, 28 W).

## 검증
| 항목 | 결과 |
|---|---|
| `npx tsc --noEmit` | 0 |
| `npm run lint` / `lint:strict` | 새 에러 0 / 132 E·28 W |
| Vitest `tests/unit` 전체 | **3,348 passed**(기존 3,341 + 훅 7건), 10 skip |
| 소스 문자열 단언 테스트 2건 갱신 | `releaseQaFollowup`·`releaseQaRaceAndAutoName` — `membership-rules` 의 `centerIdRef` effect 문자열 단언을 같은 의도(ref 는 centerId effect 한 곳에서만 갱신, 센터 변경 시 목록 초기화)를 새 코드에 맞게 변경. 삭제·skip 없음 |
| `next build` | PASS |
| Integration 전체(새 스택) | **52 files / 328 passed**, 3 skipped |
| 브라우저 QA `tests/qa/stateReset/batch2.mjs` | **23/23 PASS** — 정리 전 main(`bffe2e92`)도 23/23, **관찰값(OBS) 전부 동일, 모든 테이블/RPC 요청 수 동일(중복 호출 증가 없음)** |
| 기존 센터 권한 전환 QA `managerPerms/batch1.mjs` | 15/16 — 실패 1건(Q13 권한 조회 실패 토스트)은 **정리 전 main 에서도 같은 DB 에서 동일하게 실패**(이 시험 DB 의 센터 구성 차이, 이번 변경과 무관) |
| 기존 예약·상품·결제·NICEPAY 브라우저 회귀 | sheetCheckout 41 · classPasses 6 · backPolicy 6(+1 BLOCKED) · returnFlow 8 · reviewPath 27 · backLoop 14(+2 BLOCKED) · sheetDrag 15(+1 BLOCKED) · sheetStress 26(+1 BLOCKED) — 11/17·Batch 1 결과와 동일 |
| NICEPAY·iOS 네이티브 계약 | Vitest unit 포함 PASS(`iosVerticalBounce`·`edgeBack.native.contract`·`iosNicepaySafeArea`·`capacitorNicepayNavigation`·`nicepay*`) |

### 브라우저 QA 시나리오 (`stateReset/batch2.mjs`)
N1~N7 태블릿 매니저 nav(스와이프 펼침/접힘, 다른 메뉴 이동 시 compact 복귀, **같은 경로 메뉴 클릭 시 기존 정책대로 접힘**, **빠른 연속 3회 이동**, **화면 크기 1024→1440→1024 변경 시 펼침 잔존 없음**, 새로고침 후 compact, 스태프 권한별 메뉴 수 유지) · NM1~NM2 회원 nav · M1~M2 회원 추가 시트(검색 결과, 센터 전환 후 재오픈 시 이전 결과 없음) · C1~C4 쿠폰 지급 시트(검색 결과, 비우면 즉시 비워짐, 재입력, 닫았다 열면 비어 있음) · R1 수강권 규칙 센터 전환 · P1 판매 최대 횟수 입력(작성 중 글자 보존·행 5개 반영·비운 채 유지·포커스 잃으면 실제 행 수로 복귀) · K1 수업 등록 폼 · D1 센터 5회 빠른 전환 오늘 수업 · AA1 admin-assignments · S1 검색 화면(1자→2자→비움).

## BLOCKED / 한계
- 실기기 전용(변경과 무관): iOS 실제 rubber-band·가장자리 제스처, Android 시스템 back, 카드사 앱 실복귀.
- 브라우저로 직접 만들지 못한 경로(단위·코드 동일성으로 대체): 수업 일정 충돌 경고 **표시**(충돌 데이터 필요 — 초기화 조건은 훅 단위 테스트로 검증), `admin-assignments` "더 보기" 개수 초기화(로그 데이터 필요), `checkout` 쿠폰 목록의 상품 간 전환 초기화(회원 보유 쿠폰·두 상품 간 클라이언트 전환 필요 — checkout 기본 흐름은 sheetCheckout 41 PASS), 센터 설정 파생 표시. 이 항목들은 `useResetOnChange` 단위 테스트(7건)와 변경 전후 코드 동일성(초기화 조건·내용 동일)으로 근거를 두었다.
- 예약 화면 2건 보류(위 참조).
