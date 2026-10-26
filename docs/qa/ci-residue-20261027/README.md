# 공유 DEV CI 잔여 수업 23건 — 정리 검토 자료 v2

**상태(2026-10-27 갱신): 사람이 계획 해시 `0bbd2f61…`의 일회성 정리를 승인했고, 그 범위(수업 23·예약 12·상품 연결 2)만 `purge.mjs --execute` 로 삭제 완료.** 이 승인은 다른 데이터·다른 계획으로 확대되지 않는다(해시 고정).
스크립트의 동작은 격리 PostgreSQL+PostgREST 에서만 검증했다(`tests/rls-real/ciResidueCleanup.rls.test.ts`, 오프라인 CLI 안전장치는 `tests/unit/ciResidueCli.test.ts`).

| 파일 | 내용 |
|---|---|
| `cleanup-plan.json` / `.md` | 읽기 전용 조회로 만든 계획 v2(행 전체 해시·고유번호·연결 관계·승인 프로필·부수 효과·근거의 한계) |
| `ids.txt` · `ci-log-evidence.json` | 대상 23개 id, CI 로그에서 수집한 id 등장 기록과 job 구간(근거 원자료) |
| `../../../scripts/ci-residue/` | `core.mjs`(공용 코어) · `purge.mjs` · `restore.mjs` · `generate-plan.mjs` · `collect-ci-log-evidence.mjs` · `pinned.mjs`(검토된 계획 해시 고정) |

## 용어 — "삭제 가능"이 아니라 "일회성 정리 승인 후보"
계획의 `approvalCandidate=true` 는 **정황 근거가 있는 일회성 정리 승인 후보**라는 뜻이며 `ownershipProven=false` 다. 소유권이 증명되지 않았다.
과거 생성 응답과 실행 식별자는 **사라졌고 복구할 수 없다**(통과한 테스트는 trace 를 남기지 않고, 당시 코드는 제목에 실행 UUID 를 쓰지 않았고, manifest 는 러너와 함께 사라졌다). 이 사실을 그대로 인정하며 더 찾지 않았다.
정황 근거: 같은 CI job 로그에 id 등장 + 생성 시각이 그 job 실행 구간 안 + 제목의 `Date.now()` 일치 + 예약 프로필이 **고유번호로 확인된** 테스트 계정/익명화 계정.

## 이번 보완(검토 요청 반영)
1. **테스트 회원은 표시 이름이 아니라 확인된 계정·프로필 고유번호로 대조.** 계획 `allowedProfiles` 에 `{profileId, accountId, basis, evidence}` 를 기록하고, 실행 직전 현재 프로필의 `account_id` 가 계획 값과 같은지 본다(이름은 판정에 쓰지 않음).
   - `test-account:USER_A/USER_B` — 계정 번호가 ci:dev:seed 가 만든 CI fixture 계정(`ci-dev-accounts.env` 의 이메일 → auth 사용자 → accounts)과 같음. **이 이메일이 현재 GitHub Secrets 값과 같은지는 확인할 수 없다**(Secrets 는 읽을 수 없음).
   - `anonymized-throwaway(auth-user-deleted)` 2개(계정 1개) — 탈퇴 처리로 auth 사용자가 지워져 TEST_USER_A 플러스 별칭 여부를 **확인할 수 없다**. 근거는 약한 정황(잔여 구간 안에 만들어진 일반 계정, 관리자 아님, 이 프로필의 예약이 전부 lifecycle 스펙 수업에만 있음)이며 `strength: weak-circumstantial` 로 기록했다.
2. **건수가 아니라 고유번호·연결 관계·중요 상태·행 전체 해시를 비교**: 수업·예약·자식 행(`class_allowed_products` 등)의 id 집합과 행 해시, 예약의 수업/프로필/수강권 연결과 상태, 연결 수강권(상태·잔여 횟수), 감사 참조 0. 같은 건수라도 하나라도 다르면 쓰기 전에 중단(격리 회귀 9개 변이 + 변이 검증).
3. **대상은 정확한 HTTPS 호스트로 검증**(`https://jdglfvwdnkjnraqdxuuj.supabase.co` 만; 포트·계정정보·경로·쿼리·접미/접두 위장·HTTP·Production 거부).
4. **복원도** 승인된 계획 해시·백업 digest·허용 테이블·계획의 id/행 해시를 검증하고, 기존 행은 백업과 같으면 건너뛰고 **다르면 쓰기 전에 전체 중단**, 복원 뒤 실제 데이터를 백업과 대조한다.
5. **재개(resume)** 는 "예약이 이미 없다"만으로 하지 않는다: 이전 실행 journal + 검증된 백업(digest·계획 행 해시)과 현재 상태(수업은 계획과 동일, 예약은 없음)가 모두 맞을 때만 수업 삭제를 이어간다. journal 이 없거나 변조되면 거부. 새 `--execute` 는 journal 이 이미 있으면 거부.
6. **부수 효과 조사**(저장소 SQL + 격리 DB 실측; 공유 DEV 의 실제 트리거 목록은 PostgREST 로 볼 수 없어 **미확인**):
   - 예약 DELETE: `reservation_goods_restore_on_delete` — 차감된 대여 사용 기록이 있을 때만 대여 수강권 `remaining_count` +1(격리 DB 실측 3→4). 이 계획의 대여 사용 기록은 0건. pass 수강권 횟수는 돌려주지 않고 알림도 만들지 않음(격리 DB 실측).
   - 수업 DELETE: 저장소 SQL 에 트리거 없음(공유 DEV 미확인). CASCADE 자식은 계획에 고유번호로 기록.
   - **예약 재삽입(복원)**: `notify_reservation_insert` 가 회원·매니저에게 알림 행을 만든다(격리 DB 실측: 알림 증가). 웹푸시 경로(pg_net)는 공유 DEV 에서 미확인. 그래서 복원은 `--accept-notification-side-effects` 가 있어야 한다. `reservations_guard_pg_refund_lock` 가 환불 진행 중 수강권이면 삽입을 거부할 수 있다.

## 권한 검사가 거절한 동작과 사유 (우회하지 않음)
- 동작: Bash 로 임시 Node 스크립트를 실행해 공유 DEV(`mwhabit-ci-dev`)의 Supabase REST 에 **DELETE 요청**(대상 수업 23건의 예약 → 수업)을 보내려던 것.
- 거절 주체/사유: Claude Code auto mode 분류기, `[Modify Shared Resources]` — 공유 자원(공유 DEV 데이터) 수정. 그 직전의 읽기 전용 조회는 허용됐다.
- 처리: 사용자가 "삭제하지 마"라고 지시했고 다른 도구로 우회하지 않았다. 이후 모든 삭제·복원 검증은 격리 DB 에서만 했다.

## 삭제 승인에 남은 조건 (모두 충족돼야 사람이 승인)
1. 위 정황 근거(소유권 미증명)와 약한 익명화 근거를 보고 "일회성 정리"를 사람이 명시적으로 승인.
2. CI 테스트 계정 식별이 실제 GitHub Secrets 와 같다는 확인(사람이 Secrets/DEV 계정 대조) — 현재는 seed 계정 파일 기준.
3. 공유 DEV 의 `reservations`/`classes` 트리거 목록을 사람이 확인(Supabase SQL: `select tgname, tgrelid::regclass from pg_trigger where not tgisinternal`)하거나 알림·웹푸시 영향을 수용.
4. 실행 중인 live CI 가 없음(`gh run list --status in_progress`), 같은 센터에 다른 작업 없음.
5. dry-run 이 "대조 불일치 0건" — 계획 시점과 현재가 같음.
6. 백업 저장 위치(저장소 밖)와 복원 책임자 결정.

## 실행 방법(승인 후)
1. dry-run: `PURGE_ENV_FILE=<공유 DEV env 파일> node scripts/ci-residue/purge.mjs`
2. 실행: `PURGE_ACK=0bbd2f613ddd PURGE_ENV_FILE=… node scripts/ci-residue/purge.mjs --execute --backup-dir <저장소 밖>`
3. 중간 실패: `… purge.mjs --resume --backup-dir <같은 디렉터리>` (journal·백업 대조 통과 시에만). 복원: `… restore.mjs <backup.json> [--execute --accept-notification-side-effects]`
- 계획 해시(고정): `0bbd2f613ddd22b2aae3c97937996b009d672bfcf06360d475d3d01dfa84cc85`. 계획을 다시 생성하면 해시가 바뀌므로 `scripts/ci-residue/pinned.mjs` 갱신과 재검토가 필요하다.

## 실행 기록(2026-10-27)
- 실행 전: 계획 해시 == 고정값, CI 진행/대기 0건, dry-run 대조 불일치 0건. 백업·journal 은 저장소 밖(권한 700)에 보관했고 저장소에 포함하지 않는다.
- journal 단계: backup:done → reservations:started → reservations:done → classes:started → classes:done. 오류·중단·권한 거절 없음, 자동 복원 없음.
- 사후 별도 조회: 수업 0/23, 예약 0/12, 상품 연결 0/2 남음. 연결 수강권 6개의 상태·잔여 횟수·프로필 모두 계획과 동일. 예약을 가리키는 기존 알림 18건 유지, 감사 참조 0.
