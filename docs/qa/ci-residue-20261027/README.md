# 공유 DEV CI 잔여 수업 23건 — 정리 검토 자료 (2026-10-27)

**상태: 아무것도 삭제하지 않았다. 스크립트는 작성만 했고 한 번도 실행하지 않았다(`node --check` 문법 검사만).**

| 파일 | 내용 |
|---|---|
| `cleanup-plan.md` / `.json` | 읽기 전용(GET) 조회로 만든 계획: 수업 id·센터·제목·생성 시각·예약 수·참조 조회 성공 여부·소유권 근거·예상 삭제 범위 + 근거의 한계 |
| `purge-ci-residue.mjs` | 삭제 스크립트(검토용). 23개 id 고정, 계획 SHA-256 고정, 기본 dry-run, 실행 전 전부 재대조, 복구 자료 저장 |
| `restore-ci-residue.mjs` | 복구 스크립트(검토용). 백업 JSON 에서 수업→예약→자식 행 재삽입, 기본 dry-run |

계획 SHA-256: `eac60b4a9dbfa30fed7e4384e31800c0547927b4032e3faf7459188565f3fe8d` (`purge-ci-residue.mjs` 의 상수와 같아야 실행됨)

## 요약(계획 기준)
- 수업 23건(센터 1개), 예약 12건(테스트 프로필: CI User A/B, 스펙이 만든 임시 프로필, 탈퇴 처리된 throwaway 회원), CASCADE 자식 `class_allowed_products` 2건. `admin_action_logs` 참조 0, 그 밖의 참조 테이블 조회 전부 성공. `class_reservation_counts` 는 VIEW 라 대상 아님.
- 소유권 근거는 **정황 증거**다(같은 CI job 로그에 id 등장 + 생성 시각이 그 job 구간 안 + 제목의 `Date.now()` 일치 + 테스트 프로필 예약만). **생성 응답·실행 UUID 근거는 없다**: 통과한 테스트는 trace 를 남기지 않고, 당시 코드는 제목에 실행 UUID 를 쓰지 않았으며 manifest 는 러너와 함께 사라졌다. 자세한 한계는 `cleanup-plan.md` 말미.

## 권한 검사가 거절한 동작과 사유 (우회하지 않음)
- 동작: Bash 로 임시 Node 스크립트(`purge.mjs`)를 실행해 공유 DEV(`mwhabit-ci-dev`)의 Supabase REST 에 **DELETE 요청**(대상 수업 23건의 예약 → 수업)을 보내려던 것. 그 직전에 같은 id 목록으로 읽기 전용 조회(`inspect.mjs`)는 허용됐다.
- 거절 주체/사유: Claude Code auto mode 분류기, 사유 문구 `[Modify Shared Resources]` — 공유 자원(공유 DEV 데이터) 수정.
- 처리: 사용자가 "삭제하지 마"라고 명시했고, 다른 도구(`curl`, 다른 클라이언트 등)로 우회하지 않았다. 이 스크립트를 실행할지는 사용자가 정한다.

## 실행 방법(사용자 승인 후, 권장 순서)
1. 실행 중인 live CI 가 없는지 확인(`gh run list --status in_progress`).
2. dry-run: `PURGE_ENV_FILE=<공유 DEV env 파일> node purge-ci-residue.mjs` → "대조 불일치 0건" 확인(쓰기 없음).
3. 실행: `PURGE_ACK=eac60b4a9dbf PURGE_ENV_FILE=… node purge-ci-residue.mjs --execute --backup-dir <저장소 밖 디렉터리>`
4. 부분 삭제(예약만 지워지고 수업 삭제 실패)가 났다면: `--allow-reservations-already-deleted` 로 다시 실행하면 수업만 삭제. 필요하면 `restore-ci-residue.mjs <backup.json> --execute` 로 복원.
- 같은 센터의 live CI(E2E/Integration)와 겹치면 안 된다. 사전 대조 후 삭제 사이의 짧은 경합 가능성이 남는다.
