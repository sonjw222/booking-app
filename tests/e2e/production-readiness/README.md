# tests/e2e/production-readiness

CI의 4번째 E2E checkpoint(`tests/e2e/settings/` + 이 폴더)가 실행하는 출시 전 점검 스펙.

## admin-center-pagination.spec.ts (`/admin/centers` 커서 페이지네이션, PR #196)

> 상태: **오프라인 검증만 완료(타입/계약 테스트). DEV 실브라우저 E2E는 미실행** — 아래 전제가 갖춰지고 Mac QA 런타임에서 실행되기 전에는 PASS로 간주하지 않는다.
> #220/#222 문서 Draft는 실브라우저 증거가 아니다.

배치 이유: `.github/workflows/test.yml`은 spec을 구간(checkpoint)별 경로 필터로 배정하고 계약 테스트(`ciLiveTestWorkflow.contract.test.ts`)가 "정확히 한 구간"을 강제한다. 이 폴더는 이미 4번째 구간에 포함되어 workflow 변경이 필요 없다.

### 시나리오
접근 거부(매니저) / 플래그-RPC 일치 / 탭별 30행 경계·더 보기·중복·누락 / 검색 debounce·역전 응답 / 빈 결과 / 탭 전환 시 검색어 유지 / 네트워크 오류 / 콘솔 오류. 읽기 전용(승인·반려 클릭 없음).

### 전제와 BLOCKED(skip) 규칙
| 필요 조건 | 없을 때 |
| --- | --- |
| `TEST_PLATFORM_ADMIN_EMAIL`/`TEST_PLATFORM_ADMIN_PASSWORD` (DEV의 기존 플랫폼 관리자, 이 스펙은 계정을 만들지 않음) | 관리자 시나리오 전부 skip (BLOCKED) |
| `E2E_ADMIN_CENTER_PAGINATION_FLAG=on\|off` (실행 중 서버의 빌드 플래그 선언) | 플래그 일치 / 30행 경계 skip |
| 해당 상태 탭에 DEV 센터 31건 이상 | 그 탭의 30행 경계 skip (데이터를 만들지 않음) |

skip은 검증 완료가 아니다. 결과 보고 시 PASS / SKIP(BLOCKED) 수를 구분한다.

### 플래그 ON/OFF는 서버를 따로 띄운다
`NEXT_PUBLIC_ADMIN_CENTER_PAGINATION`은 build-time 값이다. 한 서버에서 바꿀 수 없다.
1. OFF 비교: 플래그 미설정으로 DEV 서버 기동 → `E2E_ADMIN_CENTER_PAGINATION_FLAG=off` 로 실행.
2. ON: `NEXT_PUBLIC_ADMIN_CENTER_PAGINATION=true`로 DEV 서버를 재기동/별도 빌드(`admin_list_centers_page` RPC SQL이 DEV에 적용되어 있어야 함) → `E2E_ADMIN_CENTER_PAGINATION_FLAG=on` 로 실행.
운영 환경·플래그는 변경하지 않는다. 가드(`assertIntegrationTargetIsNotProduction`)가 Production 대상을 차단한다.

### 실행 명령(Mac, DEV `.env.test.local` 기준)
```
npx playwright test auth\.setup\.ts tests/e2e/production-readiness/admin-center-pagination
```
오프라인 확인: `npx tsc --noEmit`, `npx vitest run tests/unit/ciLiveTestWorkflow.contract.test.ts`.
