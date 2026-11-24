# 매니저 권한 초기화 공통 훅(Issue #274 Batch 1) — NotebookLM 업로드용 요약 (2026-11-24)

모하빗 코드 품질 작업. 운영 동작은 바꾸지 않았고 SQL·환경변수·결제 변경은 없다. 상세는 `docs/qa/manager-perms-batch1-20261124/REPORT.md`.

- **무엇을**: 매니저 18개 화면이 똑같이 복사해 쓰던 "내 권한 조회" 코드를 `useMyEffectivePerms` 훅 하나로 통합.
- **왜**: 그 코드의 effect 안 동기 상태 변경(`setMyPerms(null)`) 때문에 ESLint `set-state-in-effect` 18건이 났고, 센터를 바꾸면 이전 센터 권한이 한 번 보였다 사라지는 깜빡임이 있었다.
- **결과**: ESLint 에러 163 → 145, `set-state-in-effect` 88 → 70(이번 18건 해결), 경고·타입 오류 증가 0. 센터 전환 후 이전 권한 노출 제거(브라우저 시험에서 정리 전 1프레임 → 0).
- **유지한 것**: 오너 전권·조회 중 메뉴 숨김·실패 시 오류 표시·권한 조회 요청 수(화면당 4회) — 모두 정리 전과 동일.
- **검증**: tsc 0, Vitest 전체 통과(훅 단위 9건 추가), `next build`, Integration 52파일 328건, 매니저 브라우저 QA 16/16, 기존 예약·결제·NICEPAY 브라우저 회귀 동일. 실기기 전용 항목은 BLOCKED.
- **다음**: 남은 `set-state-in-effect` 70건 중 "의존값 변경 시 상태 리셋 15건"(위험 낮음)을 다음 Batch 로 권장.
- **Graphify**: 새 파일 `app/components/useMyEffectivePerms.ts` 와 18개 화면 import 추가로 허브가 하나 생겼다. 필요하면 `graphify update .`(LLM 미사용) — 즉시 필요하지는 않다.
