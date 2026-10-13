# 후속 품질 검사 (2026-10-11)

기준 main: 342e48e (PR #187 병합).

## ESLint

Next 16/ESLint 9 flat config를 복구했다. 엄격 검사에서 기존 오류 1,510건, 경고 115건이 발견됐다.
기존 오류를 모두 고쳤다는 의미가 아니다. `npm run lint:strict`는 그대로 실패한다.
`npm run lint`는 파일·규칙·소스 줄별 기존 오류 개수만 허용하고 새 오류/파싱 오류는 실패한다.
기준선의 자동 갱신 명령은 제공하지 않는다. 개별 오류 수정 후 기준선 제거는 리뷰로 진행한다.
이 기준선 정책 자체도 Draft PR 검토 대상이다.

## SQL 회귀 테스트

24개 파일의 237건을 PGlite 0.3.14에서 실행해 전부 통과했다.
운영/개발 Supabase URL과 키는 사용하지 않는다. CI 별도 SQL job도 키를 받지 않는다.
한 fixture의 `RESET search_path`가 PGlite 초기값 `public` 대신 `pg_catalog`로 돌아가던 문제를 수정했다.
역할 전환 전 `SHOW search_path` 결과를 보관해 finally에서 정확히 복구한다.
이 수정은 테스트 fixture만 바꾼다. 실제 DB/RLS SQL 변경은 없다.

## 확인

- `npm run lint`: 새 오류 0 (기존 1,510)
- `npm run test:sql`: 237/237
- `npm run test:unit`: 본 배치 작성 시 main 기반 2,226 pass / 11 skip (UI 배치 포함 검증은 별도 보고)
- `npm run build`: placeholder env에서 통과

SQL 필요: NO. 실행 경로/순서/전문: 없음. 기존 운영 SQL 파일은 이 PR에서 변경하지 않았다.
