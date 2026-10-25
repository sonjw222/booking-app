# Integration 권한·요금제 변경 테스트 격리 (미커밋 검토안)

## 격리 대상과 방식
| 파일 | 위험 | 일반 CI | 수동 스위트 |
|---|---|---|---|
| `subscription-plan-limits.test.ts` | 공유 `TEST_MANAGER_A`를 임시 승격 + **전역 기본 요금제(`subscription_plans.is_default`) 변경**, afterAll에서도 기본 플랜 UPDATE | **파일 제외**(`vitest.integration.config.ts` exclude) | 실행 |
| `sec009-batch-a2-rls.test.ts` | 공유 `TEST_MANAGER_B` 임시 승격 2건 | 해당 2개 테스트만 `itPrivileged` → **SKIP**(나머지 테스트는 그대로 PASS/FAIL) | 실행 |
| `auto-book-membership-security.test.ts` | 공유 `TEST_USER_B` 임시 승격 1건(AUTO-SEC-K) | 해당 1개만 SKIP | 실행 |
| `accounts-privilege-escalation.test.ts` | 실행마다 새로 만든 임시 계정만 승격, afterAll 삭제 | 그대로 실행(공유 계정 영향 없음) | — |
| `marketing-consent`, `review-reports` | 임시 계정 생성 | 그대로 실행 | — |

테스트 본문·기대값·복구 코드는 수정하지 않았다(`it` → `itPrivileged` 교체와 import 1줄뿐). SKIP은 PASS가 아니라 SKIP으로 보고되며, 그 시나리오의 보안/기능 검증은 **일반 CI에서는 수행되지 않는다**(커버리지 공백 — 수동 스위트로 보충).

## 수동 실행 (독립된 비공유 DEV 프로젝트·계정 권장)
```
ALLOW_PRIVILEGED_DEV_TESTS=1 PRIVILEGED_DEV_TESTS_ACK=I-ACK-SHARED-DEV-ADMIN-TOGGLE npm run test:integration:privileged
```
시작 전 `privilegedPreflight.ts`(읽기 전용 — SELECT/listUsers만)가 검사하고 어긋나면 **BLOCKED로 중단, 아무것도 고치지 않는다**:
- 승격 대상 공유 계정이 이미 `is_platform_admin=true`
- 전역 기본 요금제가 정확히 1개가 아님 / QA 플랜(`QA 테스트 제한 플랜-%`)으로 오염됨
- ACK 환경변수 미지정
이 스위트의 승격 테스트는 자체 `finally`로 false로 되돌린다(기존 코드, 변경 없음). **`if: always()`나 finally만으로 취소·강제 종료 시 복구가 보장되지 않는다** — 그래서 일반 CI에서 제거했고, 수동 실행도 사람이 결과를 확인해야 한다. 자동 복구 스크립트는 만들지 않았다.
수동 스위트도 기존 `globalSetup.ts`(공유 테스트 센터 `center_settings` upsert 후 복원)를 그대로 쓴다.

## 일반 CI에 남은 DEV 쓰기 (정적 추적, 변경하지 않음 — 검증되지 않은 경로 표시)
- `integration` job `globalSetup.ts`: service role로 공유 테스트 센터의 `center_settings` upsert(종료 시 원복), 필요 시 `getOrCreateOwnedTestCenter`가 전용 센터 생성. **개별 검증하지 않음.**
- integration 52개 파일: service role로 센터·수업·수강권·결제·임시 auth 계정을 만들고 afterAll/`delete_test_center_cascade`로 정리. **파일별 정리 보장은 검증하지 않음(취소 시 잔여 가능).**
- E2E 4구간: UI를 통해 DEV에 예약·결제·수업 생성 등 업무 데이터 쓰기(설계상). **검증하지 않음.**
- `acl-fixture-repeat`: `head_ref == test/acl-fixture-restore-20261012`일 때만 실행. 대상 2개 파일에 `is_platform_admin`·요금제 변경 코드 없음(grep).
→ 일반 CI가 공유 DEV에 **전혀 쓰지 않는 것은 아니다.** 이번 변경은 "공유 계정 관리자 승격"과 "전역 기본 요금제 변경" 두 부류만 차단한다.
