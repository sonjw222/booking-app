# Production ↔ main 동기화 (2026-11-17)

## 기준
- main(`368aa3e1`, 2026-10-30)에는 그 이후 새 커밋이 없었다(main..통합 브랜치 = 운영 소스 46커밋, 통합 브랜치..main = 0 → 충돌 없음, fast-forward 가능한 선형 관계).
- 기준 운영: Vercel Production `dpl_6EEzhpHRoHBqj8Qm9ftHgzqkXRUo`(CLI 배포 소스 = 통합 브랜치 `1ace864b` 앱 코드). 직전 정상 운영(롤백 대상) `dpl_A9qKXh6tgptX2dsUNjmR8RCoAp5C`(= 커밋 `33bc408c` 소스, 파일 sha1 전수 일치 검증).
- 이 PR = 운영에 이미 반영된 소스를 main 에 기록하는 동기화. 새 기능 추가 없음(문서 `docs/*` 만 이 PR 에서 추가).

## 포함(운영 반영분)
| 영역 | 내용 | 출처 |
|---|---|---|
| NICEPAY 심사 경로 | 계정별 읽기 전용 결제창 확인, 실제 센터 허용 목록(조회 전용), 종료 후 결제 화면 복귀, 구독 상품 카탈로그(읽기 전용) | PR #265 전체(fd659321), `61b10ab9` 계열 |
| NICEPAY auth-only QA·앱 복귀 | v3 인증 전용 QA 환경(승인 API 차단), iOS/Android WebView 복귀(WapUrl/IspCancelUrl, **서버 설정 OFF**) | PR #259(d932f39f)·#264(a0ffc925) 전체 |
| NICEPAY 정기결제 심사 | hosted registration review(운영 소스 33bc408c) — 라우트·구독 심사 화면·테스트 | Codex 브랜치 `feat/nicepay-subscription-production-review-20261116` |
| iOS 네이티브 | NICEPAY 호스트 3개 정확 허용, 결제창 Safe Area, 왼쪽 가장자리 back 전용 제스처(오른쪽 앞으로 차단), 세로 바운스 제어(`setVerticalBounceEnabled`), Build 12 | 통합 브랜치 |
| UX | 결제창 종료 후 복귀, 구매 시트 역할 분리, 수강권 이름 병합, 뒤로가기 단일 정책·무한 반복 수정, 주문 옵션 검증 | 통합 브랜치 |
| 수강권 안내창 | 드래그 닫기·플릭·복구·가장자리 스와이프 차단·흰 레터박스 대응(iPhone 실기기 QA PASS) | `1ceb953b`/`cc888bde` |
결제 기능은 모두 OFF 유지(결제 prepare 503, 심사 창 API 비로그인 403). SQL 변경 없음 — 포함된 SQL 파일은 기존 승인 절차용이며 main 병합으로 실행되지 않는다.

## 제외(이 PR 에 포함하지 않은 WIP/Draft)
- PR #254 `feat/nicepay-card-review-final-20261030`(14커밋 미포함), #260 `docs/nicepay-review-readiness-20261030`(20커밋 미포함), #263 `fix/products-seller-disclosure-copy-20261031`(2커밋 미포함) — 운영에 반영되지 않은 Draft.
- 주문 사이즈 서버 검증 SQL(`add_orders_selected_size_validation_20261109_proposed.sql`) — 제안, 미적용.
- 로컬 WIP 워크트리 브랜치들(기타 `fix/*`, `chore/*`, `qa/*` 등) — 운영 소스에 없음.

## PR/Issue 상태
- Draft PR #259·#264·#265 의 커밋은 이 PR 로 main 에 포함된다(GitHub 가 병합 상태로 표시할 수 있음 — 의도된 결과).
- 열린 PR: #254·#260·#263(Draft, 미병합). 열린 이슈: #262·#261·#255·#248·#238·#221·#18.

## Vercel
프로젝트는 GitHub 연동(productionBranch=main, createDeployments enabled) — main 병합 시 Production 자동 배포가 발생한다. main HEAD 앱 코드는 운영 `dpl_6EEz…` 와 동일(문서만 추가)해야 하며 Production 환경변수는 변경하지 않는다. 이상 시 `dpl_6EEzhpHRoHBqj8Qm9ftHgzqkXRUo` 로 promote 롤백.

## Graphify / NotebookLM 요약
main 이 운영과 동기화됨: NICEPAY 심사 경로(#259/#264/#265)·구독 심사(33bc408c)·iOS Build 12 네이티브(NavigationPolicyPlugin: edge back, 세로 바운스 제어; SceneDelegate)·UX 통합이 모두 포함. 구조 변경이 큰 신규 모듈: `lib/payments/server/nicepay/*`(심사·구독 심사), `lib/sheetDrag.ts`, `lib/nativeBounce.ts`, `lib/backPolicy.ts`, `lib/payments/reviewHistory.ts`. `graphify update .` 는 이 PR 에서 실행하지 않았다(필요 시 별도).
