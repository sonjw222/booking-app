# PR #250 ↔ 최신 main(3fe7e75, PR #249 병합본) 동기화 로컬 검증 (push 없음)
- QA 브랜치 `qa/nicepay-pr250-main-sync` = `feat/nicepay-final-merge-prep-20261031`(fa02b89) + `origin/main` 병합(4562c4c) + 비활성 서버 경로 외부 호출 0건 테스트. 원격·작업 브랜치는 변경하지 않았다.
- 충돌: `docs/CHANGELOG.md`, `docs/TODO.md`(양쪽 항목 유지). 코드 충돌 없음 — `app/checkout/page.tsx` 는 #249 의 자동 예약 switch aria 한 줄만 유입(NICEPAY 변경과 겹치지 않음).
- 파일 목록: `changed-files-vs-main.txt`(main 대비), `changed-files-vs-pr250-head.txt`(#250 head 대비).
