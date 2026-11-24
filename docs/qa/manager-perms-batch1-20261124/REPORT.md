# Issue #274 Batch 1 — 매니저 권한 초기화 공통 훅 QA (2026-11-24)

기준: main `5a224efc` → 브랜치 `refactor/manager-permissions-hook-batch1-20261124`. 격리 로컬 Supabase(`mwhabit-reviewpath`) + `next build`/`start`. 실제 결제·주문·예약 생성 없음(QA 전후 orders/payments/reservations 0/0), 외부 호스트 차단, 공유 `mwhabit-isolated`·:3100·터널 미접촉.

## 개선 전 구조와 문제
18개 `app/manager/**/page.tsx` 가 같은 블록을 복사해 가지고 있었다(정규화 후 텍스트 100% 동일 18/18):
```ts
const [myPerms, setMyPerms] = useState<Set<string> | null>(null);
useEffect(() => {
  if (!activeCenter) return;
  if (activeCenter.isOwner) { setMyPerms(null); return; }   // effect 본문 동기 setState
  let cancelled = false; setMyPerms(null);                    // effect 본문 동기 setState
  fetchMyEffectivePermissionKeys(...).then((keys) => { if (!cancelled) setMyPerms(keys); }).catch((e) => { if (!cancelled) setError(e.message); });
  return () => { cancelled = true; };
}, [activeCenter]);
```
- `react-hooks/set-state-in-effect` 18건(화면당 1건 보고).
- 센터 전환 직후 한 번은 **이전 센터의 권한이 그대로 보였다가** effect 가 비운 뒤 재렌더(stale 권한 노출). 단위 시험으로 재현했고, 브라우저 QA 에서도 정리 전 main 은 센터 전환(2→1) 후 센터2 전용 메뉴가 1프레임 남았다.
- 같은 센터를 재조회(centers 재로딩)할 때마다 `null` 로 비워 메뉴가 깜빡였다.

## 개선 후 구조
`app/components/useMyEffectivePerms.ts`(신규): 조회 결과를 `{ key(센터|manager_center|role), perms }` 로 저장하고 **반환값을 렌더 중에 파생**한다.
- 오너 → null(전권, `canSeeManagerMenu` 가 true) · 센터 없음 → null · 비오너 → key 가 현재 센터와 같을 때만 권한 집합, 아니면 null(= 조회 중, 메뉴 숨김 정책 그대로).
- 센터/역할이 바뀌면 같은 렌더에서 곧바로 null → 이전 센터 권한 노출 0. 같은 센터 재조회 중에는 기존 결과 유지(깜빡임 제거).
- 유지: 의존성 `[center]`(객체가 바뀔 때 재조회 — 요청 수 동일), 실패 시 각 화면 `setError`(훅에 콜백 전달, `errMsg`), 언마운트·재조회 시 이전 응답 폐기.
- 18개 화면은 `const myPerms = useMyEffectivePerms(activeCenter, setError);` 한 줄로 교체(−198/+36줄), 안 쓰게 된 `fetchMyEffectivePermissionKeys` import 18곳 제거. ESLint 규칙 비활성화·`eslint-disable`·의존성 무조건 추가·불필요한 memo 없음, 권한 로딩 상태(`permsLoading`)·`canSeeManagerMenu` 그대로.

## ESLint 측정 (`npx eslint .`, 전 → 후)
| 항목 | 전 | 후 |
|---|---|---|
| 전체 Error / Warning | 163 / 28 | **145 / 28** |
| `react-hooks/set-state-in-effect` | 88 | **70** (이번 Batch 18건 중 **18건 해결**) |
| 새로 생긴 경고 | — | 0 (일시적 unused import 18건은 제거) |
| 다른 파일로 이동한 경고 | — | 0 |
baseline(`scripts/lint/baseline.json`)은 `updateBaseline.mjs` 로 재생성만 했다(142 → 124 키, 163 → 145건, 증가 0, 설정 완화 없음).

## 검증
| 항목 | 결과 |
|---|---|
| `npx tsc --noEmit` | 0 |
| `npm run lint` / `npm run lint:strict` 집계 | 새 에러 0 / 145 E·28 W |
| Vitest `tests/unit` 전체 | PASS(훅 단위 테스트 9건 포함, 기존 3,332 + 9) |
| 훅 단위 테스트 `useMyEffectivePerms.test.ts` (jsdom) | 9 PASS: 센터 없음/오너 null·조회 없음, 조회 중 null→집합·1회, 센터 전환 시 이전 권한 노출 0, 빠른 전환 stale 응답 폐기, 실패 시 onError·null, 같은 센터 재조회 중 유지, 오너↔비오너 전환, 언마운트 후 응답 무시 |
| `next build` | PASS |
| Integration 전체(`npm run test:integration`, 새 격리 스택) | **52 files / 328 passed**, 3 skipped (매니저 권한 `manager-permission-gating` 포함) |
| 브라우저 QA `tests/qa/managerPerms/batch1.mjs` | **16/16 PASS** (정리 전 main `5a224efc` 는 15/16 — Q7 센터 전환 stale 1프레임) |
| 기존 예약·상품·결제·NICEPAY 브라우저 회귀 | sheetCheckout 41 · classPasses 6 · backPolicy 6(+1 BLOCKED) · returnFlow 8 · reviewPath 27 · backLoop 14(+2 BLOCKED) · sheetDrag 15(+1 BLOCKED) · sheetStress 26(+1 BLOCKED) — 11/17 결과와 동일 |
| NICEPAY·iOS 네이티브 계약 테스트 | Vitest unit 에 포함되어 PASS(`iosVerticalBounce`·`edgeBack.native.contract`·`iosNicepaySafeArea`·`capacitorNicepayNavigation`·`nicepay*` 등) |

### 매니저 브라우저 QA 항목(`managerPerms/batch1.mjs`)
Q1·Q4 오너·스태프 각 18개 화면 정상 렌더링 · Q2·Q3 오너 센터 전환 시 전체 메뉴·권한 조회 요청 0건 · Q5·Q6 스태프 센터1(제한 3개) ⊂ 오너(21개) < 센터2(확장) · **Q7 센터 전환 후 stale 메뉴 0프레임** · Q8 새로고침 후 권한 복원 · Q9 권한 없는 센터에서 관리 버튼 숨김 · Q10 로그아웃(저장소·쿠키 삭제) 후 다른 계정 로그인 시 이전 권한 흔적 없음 · Q11 6개 연속 빠른 이동 · **Q12 권한 조회 요청 화면당 4회 — 정리 전과 동일(중복·무한 호출 없음)** · Q13 조회 실패(500) 시 기존 오류 토스트·관리 버튼 비노출 · Q14 태블릿 폭 nav 스태프 메뉴·스와이프 펼침 · Q15 pageerror·무한 렌더링 경고 0 · Q16 외부 요청 차단.

## BLOCKED(실기기 전용 — 이번 변경과 무관)
iOS 실제 rubber-band·가장자리 제스처·오른쪽 앞으로 차단, Android 시스템 back, 카드사 앱 실복귀. `ios/`·`android/`·`capacitor.config.ts` 변경 0.

## 한계
브라우저 QA 의 스태프/오너 시험 데이터(센터 2개·역할 2개)는 격리 DB 에 임시로 만든 것이며 `tests/qa/managerPerms/batch1.mjs` 머리 주석에 전제를 적었다(시험 데이터 생성 스크립트는 저장소에 포함하지 않음). 18개 화면의 화면별 세부 기능(저장·삭제 등)은 이번 변경 범위가 아니어서 새로 시험하지 않았고 기존 화면 코드는 권한 훅 호출 한 줄 외 변경이 없다.
