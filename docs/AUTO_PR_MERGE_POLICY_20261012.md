# PR 자동 병합 안전 판정 정책 (2026-10-12, Issue #214)

## 0. 현재 상태 요약

| 항목 | 상태 |
| --- | --- |
| 자동 병합 활성화 | **NO** (이 Issue는 판정 엔진·테스트·문서만 추가) |
| 실제 PR 병합/닫기/라벨 변경 | 수행하지 않음 |
| SQL 실행 | **NO** (경로·순서·전문: 없음). 확인: 변경 파일에 `*.sql`, `supabase/**`가 없음(`git diff --stat main...HEAD`) |
| 워크플로우(`.github/**`) 변경 | 없음 |
| Mac merge-agent 설치 | 이 Issue로 설치되지 않았다. 기존 자동화(`/Users/sonjw/Documents/mwhabit-automation`)는 다른 머신에 있으며 이 문서는 그 상태를 주장하지 않는다 |

## 1. 구성

- `lib/automation/mergePolicy.ts` — `evaluateMergePolicy(input, options)` 순수 함수. 네트워크·Git·파일 I/O 없음.
- `tests/unit/mergePolicy.test.ts` — 성공/실패/기본 거부 경계 테스트.
- 결과: `MERGE_ELIGIBLE` / `WAIT` / `MANUAL_APPROVAL` / `BLOCK` + 이유 목록(`code`, `verdict`, `message`).
- 여러 이유가 있으면 `BLOCK > WAIT > MANUAL_APPROVAL > MERGE_ELIGIBLE` 순으로 가장 엄격한 결론을 택한다.
- 입력 수집과 결론은 분리되어 있다. 엔진은 입력의 **형식**만 보며, 입력의 **진위**는 실행기가 보장해야 한다(§4).

## 2. 판정 규칙 (Fail closed)

초기 자동 병합 가능 범위는 **순수 문서(`docs/**/*.md|mdx|txt`)** 와 **내용 스캔이 끝난 일반 단위 테스트(`tests/unit/*.test.ts`)** 뿐이다. 그 외는 모두 `MANUAL_APPROVAL` 이상이다(기본 거부).

| 구분 | 결론 |
| --- | --- |
| `.env*`, 비밀키·인증서 파일, 비정상 경로(`..`, 절대경로), symlink, submodule | BLOCK |
| `*.sql`, `supabase/**`, `.github/**`, `scripts/**`, `ios/**`, `android/**`, `package.json`·lockfile, 설정 파일, `tests/e2e/**`, `app/**`, `lib/**`, `tools/**` | MANUAL_APPROVAL |
| 인증·결제·예약/수강권·권한(ACL/RLS/RPC)·admin·CI 등 키워드가 있는 단위 테스트 | MANUAL_APPROVAL |
| 테스트가 운영 데이터/권한에 쓰기(`contentScan.writesData`) | BLOCK |
| 내용 스캔이 없는 단위 테스트(경로만으로 안전을 증명할 수 없음) | MANUAL_APPROVAL |
| rename/remove/copy, patch 없음, 파일 목록 불완전, 대량 변경(>10개 파일 또는 >400줄) | MANUAL_APPROVAL |
| 이미 병합/닫힘, base≠main, fork, HEAD SHA 불일치, 승인 후 HEAD 변경, 충돌/dirty, 실패한 check, 실행기가 수집하지 않은 증거, 무관한 패치 | BLOCK |
| Draft, mergeable unknown, behind, pending/취소/누락 check, 오래된 증거(HEAD 또는 main 변경), E2E 필요하나 미실행, 미병합 선행 PR | WAIT |
| 작성자 미확인/비신뢰, `ai-merge-approved` 없음, 승인 SHA 미기록, required check 목록 미확인 | MANUAL_APPROVAL |

선행 PR이 미병합이면 실패한 check는 BLOCK이 아니라 WAIT로 처리한다(예: 실패 재현 PR #211은 수정 PR #213에 종속).

승인 규칙:

- 명시적 PR 승인 라벨 `ai-merge-approved` + **승인 당시 HEAD SHA 고정**이 모두 필요하다.
- GitHub Issue용 `ai-dev-approved`는 PR 병합 승인이 아니다.
- 승인 후 HEAD가 바뀌면 이전 승인은 무효(BLOCK)다.

검증 규칙:

- required check뿐 아니라 GitHub checks/Actions workflow 전체를 집계한다.
- check는 **현재 HEAD**에서 실행된 것만 인정한다. 과거 CI 통과는 인정하지 않는다.
- 현재 HEAD + **최신 main** 합성 검증 증거가 없거나, 그 사이 main이 바뀌었으면 WAIT(재검증).

## 3. 대표 PR 분류(테스트로 고정)

| PR | 성격 | 결론 |
| --- | --- | --- |
| #194 | CI 변경 | MANUAL_APPROVAL |
| #197 | 권한 fixture 조작 테스트 | MANUAL_APPROVAL (데이터 쓰기 확인 시 BLOCK) |
| #193 | UI | MANUAL_APPROVAL |
| #196 | SQL | MANUAL_APPROVAL |
| #211 | 실패 재현 E2E, #213 종속 | WAIT |
| #213 | UI 버그 수정 | MANUAL_APPROVAL |
| #205 | 실패 보고서 | BLOCK |
| 일반 문서 | 모든 조건 충족 | MERGE_ELIGIBLE |

위 표는 테스트용 가상 입력 기준이며 실제 PR 상태를 조회·변경하지 않았다.

## 4. 한계와 실행기의 책임

엔진은 입력을 신뢰하는 순수 함수이므로 다음은 **실행기가 직접 수집·검증**해야 한다.

- GitHub API에서 병합 직전 재조회한 HEAD/main SHA, 라벨(+라벨 부착 시점·부착자), 작성자, fork 여부, 파일 목록(페이지네이션 완료 여부), 파일 mode, required check(브랜치 보호 규칙).
- PR 본문/코멘트에 적힌 CI 결과 주장은 증거가 아니다. 실행기가 최신 main과 합성해 직접 돌린 결과만 `collectedByExecutor: true`로 넘긴다.
- 단위 테스트 patch 내용 스캔(DB/네트워크 쓰기, 인증·결제·예약 접근 여부). 스캔할 수 없으면 `contentScan`을 비워 MANUAL_APPROVAL로 떨어뜨린다.
- 경로 키워드는 휴리스틱이다. 키워드 목록에 없는 민감 테스트는 내용 스캔이 막아야 한다.

주의: **문서 전용 PR이라도 main 병합은 Vercel 배포를 유발할 수 있다.** 배포 설정에 따라 빌드·프리뷰·프로덕션 반영이 일어나므로 병합 시간대와 배포 영향을 별도로 확인한다.

## 5. 위험 관리

- 기본 dry-run: 판정 결과만 보고하고 병합 API를 호출하지 않는다.
- 병합 호출 시에는 판정 직후 HEAD SHA를 고정해 병합 요청에 `sha`를 넣어, 판정 이후 push가 있으면 GitHub가 거부하게 한다(후속 구현).
- kill switch(환경변수/파일) 및 1회 실행당 병합 건수 상한을 둔다(후속 구현).
- 규칙을 완화하는 변경(허용 범위 확대)은 별도 Issue와 사람 승인으로만 한다.

## 6. 후속 Mac merge-agent 연동 계획 (이 Issue 범위 아님)

각 단계는 사용자의 별도 승인이 필요하다.

1. 읽기 전용 토큰으로 PR/checks/branch protection 수집기 구현 → dry-run 보고만(병합 권한 없음).
2. dry-run 보고를 일정 기간 사람이 검토하여 오판 0건 확인.
3. 병합 권한(`pull_requests: write`) 부여 여부를 결정하고, 문서 전용 PR 한정 병합을 시범 활성화.
4. 단위 테스트 범위 확대 여부는 별도 결정.

GitHub 쌓인 Issue/PR의 중복·의존성·검증/병합 순서 inventory는 별도 후속으로 진행하며, 이 Issue에서는 다른 PR을 병합하거나 닫지 않는다.

## 7. dry run 결과 보고 형식

```
PR #<번호> <제목>
HEAD: <sha> / main: <sha> / 승인 SHA: <sha|없음>
판정: MERGE_ELIGIBLE | WAIT | MANUAL_APPROVAL | BLOCK
이유:
 - [<code>] <message>
수행한 조치: 없음 (dry-run)
```

보고에는 토큰·비밀키·환경변수 값을 포함하지 않는다.
