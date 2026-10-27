# #240 CI 격리 이전 — 구현·검증 현황 (2026-10-27)

**상태: 구현 완료 · 로컬 실검증 완료 · 원격 CI 통과(PR #244, run 40482669365) · 원격 취소 시나리오 검증 완료(run 40489588546, 취소된 실행으로 따로 기록).** 병합과 병합 후 확인이 끝나기 전에는 #240 을 닫지 않는다.

## 1. 무엇을 바꿨나 (한 줄)
live E2E 4구간과 Integration 이 공유 DEV(`mwhabit-ci-dev`)와 GitHub Secrets 대신, **각 job 이 자기 러너 안에 띄우는 일회용 Supabase 전체 스택**(`isolated-supabase/`, Auth·PostgREST·Storage·Realtime·Edge Functions)만 쓰도록 바꿨다.

## 2. 환경 선택 근거 (확인한 사실)
| 항목 | 확인 결과 |
|---|---|
| Supabase 호스팅 프로젝트 | 2개뿐: Production(`bxntqgg…`), 공유 DEV `mwhabit-ci-dev`(`jdglfv…`). 브랜치 없음. 조직 2개(`sonjw222`, `mwhabit-ci`) |
| 새 호스팅 프로젝트/브랜치 | 만들 수 있으나 **비용·추가 권한 판단이 필요**(조직 플랜·활성 프로젝트 한도·브랜치 과금은 이 세션에서 확인 불가). 사람의 선택 사항으로 남김 |
| 채택안 | **일회용 로컬 Supabase 스택**(CLI `supabase start`) — 비용 0, 실행마다 새 DB, job 종료 시 `supabase stop --no-backup` 으로 데이터까지 삭제, Secrets 불필요 |
| 호스팅 프로젝트 지원 | 가드(`scripts/ci/isolatedTargetGuard.mjs`)는 호스팅 격리 프로젝트(`ISOLATED_KIND` 기본값 `hosted-project`)도 계속 지원한다 — 나중에 전환할 때 같은 가드를 쓴다 |

## 3. 구성
| 파일 | 역할 |
|---|---|
| `isolated-supabase/` | 스택 설정·baseline·시드·Edge 함수 링크(자세한 설명: `isolated-supabase/README.md`) |
| `.github/actions/isolated-supabase/action.yml` | 스택 기동 → 접속값 내보내기 → **가드 OK 확인** → fixture 생성 → 테스트 환경 내보내기 |
| `scripts/ci/isolatedTargetGuard.mjs` | 가드. kind=`ephemeral-local-stack` 은 URL `http://127.0.0.1\|localhost:<포트>` + ref `local:mwhabit-isolated` + 로컬 데모 JWT(`iss=supabase-demo`, `ref` 클레임 없음)일 때만 OK. 호스팅 프로젝트 키·Production·공유 DEV 는 FAILED |
| `scripts/isolated/stackEnv.mjs` · `bootstrapEphemeral.mjs` | 스택 접속값 추출 / 테스트 계정(USER_A/B, MANAGER_A/B)·센터·상품 생성(비밀번호는 실행마다 새로, 로그·저장소에 남지 않음) |
| `scripts/isolated/extractCatalogSeed.mjs` · `verifyBaselineParity.mjs` · `dumpBaseline.md` | 카탈로그 시드 생성 / 공유 DEV 와 구조·권한 대조(개발자 도구) / baseline 재생성 절차 |
| `.github/workflows/test.yml` | live job 6개(E2E 4, Integration, ACL 반복)가 위 action 을 쓴다. **workflow 에 `secrets.` 참조가 0개**(contract test 로 고정) |

### 데이터·권한 원칙
- baseline = 공유 DEV `public` 스키마의 **스키마-only 덤프**(행 데이터 0, JWT·이메일·URL·ref 0 — 단위 테스트가 위생을 고정) + Storage 정책 7개 + 로컬 이미지의 기본 권한 초기화. 공유 DEV·운영의 **회원/센터/결제 데이터는 복사하지 않았다**.
- 카탈로그(permissions 121 · subscription_plans 1 · service_categories 9)는 **저장소 루트 SQL 의 INSERT 문장에서 생성**했다. 공유 DEV 와는 권한 키 *이름*만 대조해 집합이 같음을 확인했다.
- 외부 문자·이메일·웹푸시·결제: 이 스택에는 ALIGO 등 외부 발송 자격증명이 **없다**(OTP 는 `0100000` 접두 번호만 우회 코드 반환). 공유 DEV 에도 `pg_net`/`pg_cron` 이 없어 DB 내 외부 호출 경로가 없다. 결제는 기존 테스트 mock provider(`confirm_test_payment`)만 쓴다.

## 4. 호스팅 프로젝트와 다른 점 (숨기지 않는다)
같은 GoTrue/PostgREST/Storage/Realtime/Edge Runtime 이미지를 쓰지만 **호스팅 인프라가 아니다.** 네트워크 지연, Management API/대시보드 전용 설정, 백업, 호스팅 전용 확장, Edge Functions 의 호스팅 런타임은 재현하지 않는다. "호스팅 Supabase 프로젝트에서 통과"를 뜻하지 않는다.

## 5. CI job 별 대상 (변경 전 → 후)
| job | 이전 | 이후 |
|---|---|---|
| live-env-preflight | env 검사(Secrets) | **삭제**(가드는 스택 action 안에서 테스트 전에 실행) |
| E2E 1~4 | 공유 DEV, Secrets 13개, 순차 체인, 전역 큐 | **각자 일회용 스택**, Secrets 0, 독립(병렬), PR 단위 concurrency |
| Integration | 공유 DEV | 일회용 스택 |
| acl-fixture-repeat | 공유 DEV(특정 브랜치) | 일회용 스택(조건 동일) |
| sql / lint / unit / build | 변경 없음 | 변경 없음 |
| isolated-env-gate(#243) | `ISOLATED_*` 시크릿 검사 | **삭제**(호스팅 프로젝트를 쓰지 않는 한 불필요; 가드·문서는 유지) |
- 실행 조건(push 제외, fork PR 제외)과 `--max-failures=1`·재시도 정책은 그대로다. 가드가 OK 가 아니면 테스트 단계가 시작되지 않고 job 이 **실패**한다(skip·통과·공유 DEV 대체 없음).

## 6. 로컬 실검증 (이 Mac 의 Docker, 2026-10-27)
격리 스택에서 workflow 와 같은 명령으로 직접 실행했다(E2E 는 그룹마다 스택을 새로 리셋하고 fixture 를 새로 만듦). **원격 CI 결과가 아니다.** 최종 수치는 §8 표.
- baseline 구조·권한 대조(`verifyBaselineParity`): 함수 171(ACL·SECURITY DEFINER 포함)·릴레이션 94(ACL·RLS)·정책 200·컬럼 850·Storage 정책 7·버킷 3·트리거 36 모두 **차이 0**.
- 격리 스택에서 처음 드러난 숨은 의존(= 예전 공유 DEV 가 누적 상태로 가려 주던 전제)과 조치:
  1. `confirm_real_payment`/`cancel_real_payment` 를 authenticated 가 호출할 수 있었음 → 로컬 이미지의 기본 권한 부여가 원인. baseline 앞에 기본 권한 초기화 migration 추가 후 DEV 와 ACL 일치.
  2. 내부 QA 센터는 `center_members` 가 아니면 보이지 않는데 E2E fixture 는 수강권을 직접 넣어 `center_members` 가 안 생김 → E2E 용 `getOrCreateOwnedTestCenter` 래퍼가 user-a/b 를 센터 회원으로 등록(`ensure_center_member`, 멱등).
  3. 취소 화면은 `center_settings` 행을 가정(없으면 "취소 조건을 확인하지 못했어요") → 같은 래퍼가 없을 때만 기본 행을 만든다.
  4. `new-class-creation.spec` 는 "회원이 이미 pass 를 보유"를 앞 구간·이전 실행 상태에 기대고 있었음 → beforeAll 이 직접 만든다.
  5. vitest 가 이전 실패 파일을 먼저 돌리는 결과 캐시 때문에 Integration 파일 순서가 바뀌면 `manager-set-attendance-membership-integrity` 가 앞 파일 상태에 영향을 받는 **기존 순서 의존**이 보였다(CI 는 캐시 없는 cold 실행이라 같은 순서로 통과). 원인 파일은 특정하지 못했고 `docs/TODO.md` 에 남겼다.
- 알려진 skip(이전 공유 DEV CI 와 **동일한 수**): E2E 3 = 5건(실제 Toss 게이트웨이 1, 미구현 placeholder 4), E2E 4 = 9건(플랫폼 관리자 필요 admin-center-pagination), Integration = 3건(`ALLOW_PRIVILEGED_DEV_TESTS` 게이트 — 공유 계정 승격·전역 요금제 변경 테스트). 통과로 세지 않고 skip 으로 보고한다.

## 7. 정리·복구·충돌
- **정상 종료·실패·취소 모두**: 스택은 job 의 `if: always()` 단계가 내리고(데이터 볼륨 삭제), 러너 자체가 일회용이다. 취소로 단계가 못 돌아도 VM 이 폐기돼 공유 자원에 남는 것이 없다(공유 DEV/운영에 쓰는 경로가 없음).
- **실행 간 충돌**: 실행마다 스택이 따로라 공유 데이터가 없다(E2E 4구간·Integration 이 병렬로 돈다).
- **소유권 없는 데이터 보존**: 같은 스택 안에서의 안전장치는 Q01 의 실행 소유 증명 정리(#241)가 그대로 담당한다(미증명 같은 제목·다른 프로필 예약은 삭제하지 않고 BLOCKED/FAILED). E2E 로컬 실행에서 teardown "미해결 0" 을 확인했다.
- **원격 취소 시나리오(실측, 2026-10-27)**: 이 브랜치(HEAD `efa1997`)의 `workflow_dispatch` 실행 40489588546 을 스택 기동·fixture 생성(`fixture 준비 완료` 로그) 이후, E2E 3/4 job 이 Playwright 단계에 들어간 시점에 `gh run cancel` 로 취소했다(이 실행만; 같은 커밋의 PR 검증 실행·다른 사람의 실행은 건드리지 않음).
  - 결과: run `cancelled`, E2E 3/4 job `cancelled`, `Playwright e2e-3…` 단계 `cancelled`(로그 `The operation was canceled.`), 그 뒤 **`Stop the isolated stack (always; nothing persists)` 단계가 실행되어 `success`**, 로그에 `Stopped supabase local development setup.`.
  - 이 실행은 **정상 CI 통과로 세지 않는다**(cancelled). 취소 전에 이미 끝난 다른 job 들은 success 였지만 그 수치도 정상 CI 근거로 쓰지 않는다.
  - **확인할 수 없는 것**: 스택 종료 뒤 컨테이너·볼륨이 실제로 비었는지는 원격 러너에서 직접 관찰할 수 없다(로컬에서는 같은 명령 뒤 컨테이너·볼륨 0 을 확인했다). 러너 VM 폐기는 GitHub 의 동작이며 여기서 관찰한 사실이 아니다.

## 8. 완료 기준 체크
| 기준 | 상태 |
|---|---|
| 필수 E2E 4 + Integration 이 격리 환경에서 실제 실행(의도치 않은 skip 0) | 로컬 실행 완료(아래 표) + **원격 CI 통과**(run 40482669365: E2E 18/13/49/28 passed, Integration 328 passed, skip 은 기존 5/9/3 그대로, 실패 0) |
| 운영·공유 DEV 로의 쓰기 0 | 설정으로 증명: workflow·action 에 `secrets.` 0, 공유 DEV/운영 ref 문자열 0, 테스트 전 가드(ephemeral kind 만 OK). 실행 기록: 대상 호스트 `127.0.0.1:54421` |
| fixture 생성·실행 소유 정리·실패/취소 복구 | 로컬 확인(§7) + 원격: 각 E2E job teardown "미해결 0"(3/14/79/25건), **원격 취소 시 정리 단계 실행·스택 종료 로그 확인**(§7, 취소된 실행으로 별도 기록) |
| 현재 필수 체크와 비교 후 전환 | 이전 공유 DEV CI(run 40447976252)와 원격 격리 CI(run 40482669365)의 통과·skip 수 동일 |
| 공유 DEV 잔여(수업 2·예약 4·임시 계정 1) | 삭제하지 않음(승인 범위 밖) — 정리가 필요하면 별도 승인 |

### 최종 로컬 실행 표
| 구간 | 명령(workflow 와 동일) | 통과 | skip | 실패 | 그룹 종료 시 수업 정리(미해결) |
|---|---|---|---|---|---|
| E2E 1/4 auth + attendance | `playwright test --max-failures=1 auth.setup tests/e2e/auth/ …attendance.spec` | 18 | 0 | 0 | 3건 (0) |
| E2E 2/4 admin 설정류 | 동일 형식 | 13 | 0 | 0 | 14건 (0) |
| E2E 3/4 새 수업·예약·결제 | 동일 형식 | 49 | 5 (Toss 실게이트웨이 1 + 미구현 placeholder 4) | 0 | 79건 (0) |
| E2E 4/4 설정 + production-readiness | 동일 형식 | 28 | 9 (플랫폼 관리자 필요) | 0 | 25건 (0) |
| Integration (cold 캐시) | `vitest run --config vitest.integration.config.ts` | 328 (52개 파일 전부) | 3 (privileged 게이트) | 0 | — |
- 비교 기준(이전 공유 DEV CI run 40447976252): E2E 18 / 13 / 49+5skip / 28+9skip — **통과·skip 수가 같다.** E2E 수업 정리 건수도 같다.
- "did not run" 0 (fail-fast 로 중단된 구간 없음). 모든 실행의 대상 호스트는 `127.0.0.1:54421`(가드 OK, kind=ephemeral-local-stack).
- **복구 확인(로컬)**: 실행 도중 SIGKILL → 스택은 `supabase stop --no-backup` 후 컨테이너·볼륨 0, 재기동한 스택은 accounts/centers/classes/reservations/auth.users 0건(카탈로그 시드만 존재).
- 아직 안 한 것·한계: **호스팅 Supabase 프로젝트에서의 실행**(실행한 것은 일회용 로컬 Supabase 전체 스택이다), 원격 러너에서 종료 후 컨테이너·볼륨 상태의 직접 관찰.
- 이어지는 제한(이번 전환의 결과가 아니라 기존 사항): Integration 파일 간 순서 의존 1건(`docs/TODO.md`), 기존 skip(E2E3 5 · E2E4 9 · Integration 3).
- 실행 대상 근거 표현: 전체 로그에는 Build job 의 placeholder URL(`build-placeholder.supabase.co`)이 있다(live 아님). 그래서 "`.supabase.co` 문자열이 없다"가 아니라, **live job 의 실행 대상은 가드 기록(`isolated-target-guard: OK (kind=ephemeral-local-stack)`)과 접속 주소 `http://127.0.0.1:54421`**, 그리고 workflow·action 의 `secrets.` 0개 · 공유 DEV/운영 ref 문자열 0개로 설명한다.

## 9. 사람이 해야 할 일 (최소)
1. 이 PR 의 CI 결과를 확인하고 병합 여부 결정.
2. (선택) 병합 후 사용하지 않는 공유 DEV용 GitHub Secrets 13개(`NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`, `TEST_*`) 정리·키 회전 여부 결정 — 이 workflow 는 더 이상 읽지 않는다(`mobile-ui-qa.yml` 은 TEST_USER/MANAGER Secrets 를 계속 쓴다 — Production QA 용도, 이번 범위 밖).
3. (선택) 호스팅 격리 프로젝트가 필요하면: 프로젝트/브랜치 생성(비용 판단) → `ISOLATED_*` 4개 등록 → 이 가드(kind=`hosted-project`)로 전환. 현재는 불필요.
4. 공유 DEV 잔여 3종 정리 승인 여부.
