# CLAUDE.md

Claude Code가 이 저장소(`booking-app`)에서 작업할 때 항상 따라야 하는 규칙입니다.
작업을 시작하기 전에 이 파일 전체를 읽었다고 가정합니다.

## 프로젝트 한 줄 요약

센터(스튜디오/체육관) 예약·회원 관리 앱. Next.js 16 + React 19 + Supabase(Postgres/Auth/Storage/Realtime).
별도 API 서버 없이 `lib/*.ts`가 Supabase를 직접 호출하고, RLS가 최종 접근 통제 계층입니다.
자세한 내용은 아래 "참고 문서"를 먼저 확인하세요 — 이 파일에서 프로젝트 구조를 다시 설명하지 않습니다.

## 필수 규칙

1. **작업 전에 관련 코드와 docs를 먼저 확인한다.**
   손대려는 파일을 `Read`로 직접 열어보고, 관련된 `docs/*.md`(PROJECT_OVERVIEW, REQUIREMENTS, DATABASE, ROUTES)를 확인합니다.
   `docs/` 문서는 특정 시점의 스냅샷이라 코드와 어긋날 수 있으므로, 문서 내용과 실제 코드가 다르면 **코드를 신뢰**하고 문서를 갱신하세요.

2. **복잡한 작업(여러 파일/도메인에 걸친 변경)은 Graphify 결과를 먼저 참고한다.**
   `graphify-out/GRAPH_REPORT.md`(커뮤니티/허브 요약)와 `graphify-out/graph.json`을 먼저 봅니다.
   특정 파일이 어디와 연결되는지 궁금하면 `graphify explain "파일명 또는 심볼"`, 두 파일 사이 영향 경로가 궁금하면
   `graphify path "A" "B"`를 실행해 영향 범위를 파악한 뒤 수정 계획을 세우세요. 절차는 [docs/AI_PLAYBOOK.md](docs/AI_PLAYBOOK.md) 참고.

3. **사용자 승인 없이 Supabase 테이블이나 기존 데이터를 삭제하지 않는다.**
   `DROP TABLE`, `WHERE` 없는 `DELETE`/`UPDATE`, `TRUNCATE`, 컬럼 삭제, 기존 RLS 정책 제거 등은 반드시 먼저 사용자에게
   설명하고 명시적 동의를 받은 뒤에만 진행합니다. `reset_test_data.sql` 같은 기존 파괴적 스크립트도 운영 DB에 실행 제안 금지.

4. **데이터베이스 변경은 반드시 새 SQL migration 파일로 작성한다.**
   기존 `schema.sql`을 직접 고치지 말고 `add_<기능>.sql` 또는 `fix_<문제>.sql` 형식의 새 파일을 저장소 루트에 추가합니다
   (기존 관례, [docs/DATABASE.md](docs/DATABASE.md) 참고). 새 테이블에는 RLS 활성화와 정책을 같은 파일에 포함합니다.

5. **환경변수와 비밀키는 코드나 Git에 저장하지 않는다.**
   `.env.local`(Supabase URL/anon key)은 `.gitignore`의 `.env*`로 이미 제외되어 있습니다. 새 비밀키(서비스 롤 키 등)가
   필요해도 코드에 하드코딩하거나 커밋에 포함하지 않습니다. `git add` 전 `git status`로 `.env*`가 스테이징되지 않았는지 확인하세요.

6. **기능 수정 후 TypeScript 오류와 lint 오류를 확인한다.**
   `npm run build`가 TypeScript 타입체크를 포함합니다. **주의**: 현재 `npm run lint`는 `eslint.config.js`가 저장소에
   없어서 즉시 실패합니다(확인됨, 2026-07-28). 이 설정 파일을 새로 만드는 것은 이 규칙의 범위를 벗어나는 별도 작업이므로,
   lint 설정을 고치는 작업이 아니라면 `npm run build`의 타입체크로 대체하고 이 사실을 사용자에게 알리세요.

7. **`npm run build`가 성공하기 전에는 커밋하지 않는다.**
   빌드 실패를 타입 단언(`as any`)이나 `// @ts-ignore`로 우회하지 않고 근본 원인을 고칩니다.

8. **변경된 기능은 `docs/CHANGELOG.md`에 기록한다.**
   무엇을 왜 바꿨는지 한두 줄로 추가합니다(날짜 포함). 커밋 메시지와 중복되어도 괜찮습니다 — 변경 이력은 두 곳에 남기는 것이 안전합니다.

9. **남은 작업은 `docs/TODO.md`에 반영한다.**
   작업 중 발견했지만 이번 범위에서 처리하지 않은 이슈나 후속 작업은 `docs/TODO.md`의 우선순위 규칙(P0~P3)에 맞춰 추가합니다.

10. **구조 변경이 있으면 Graphify 그래프 갱신이 필요한지 확인한다.**
    파일 추가/삭제/이동, 모듈 간 의존관계가 바뀌는 변경을 했다면 `graphify update .`(빠름, LLM 미사용)로 그래프를 갱신할지
    사용자에게 확인합니다. 클러스터링/보고서까지 다시 만들려면 `graphify cluster-only .`가 필요합니다(LLM 호출 발생 — 비용 있음, 사용자 확인 후 실행).

11. **커밋 전 `git diff`와 `git status`를 사용자에게 요약한다.**
    변경된 파일 목록과 각 변경의 요지를 사람이 읽기 쉬운 문장으로 정리해 보여준 뒤 커밋을 진행합니다. 진단 없이 바로 커밋하지 않습니다.

12. **사용자가 명시적으로 요청하기 전에는 `git push`하지 않는다.**
    커밋까지는 지시가 있으면 진행할 수 있지만, push는 매번 별도의 명시적 요청이 있어야 합니다.

13. **사용자 승인 없이 대규모 리팩터링을 하지 않는다.**
    요청받은 범위를 벗어나는 파일 재구성, 대량 이름 변경, 아키텍처 변경은 먼저 계획을 제시하고 승인을 받은 뒤 진행합니다.

## 참고 문서

| 문서 | 내용 |
|---|---|
| [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md) | 프로젝트 목적, 기술 스택, 폴더 구조 |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | 실제 구현된 기능 vs 미구현 기능(코드로 검증됨) |
| [docs/DATABASE.md](docs/DATABASE.md) | Supabase 테이블, RLS, SQL 마이그레이션 목록 |
| [docs/ROUTES.md](docs/ROUTES.md) | 전체 라우트, 접근 통제 실태 |
| [docs/DEVELOPMENT_RULES.md](docs/DEVELOPMENT_RULES.md) | 코딩 규칙(TypeScript `any` 금지 등) 상세 |
| [docs/AI_PLAYBOOK.md](docs/AI_PLAYBOOK.md) | 기능 개발/버그 수정/DB 변경 단계별 절차 |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | NotebookLM/ChatGPT/Graphify/Claude Code/GitHub/Vercel/Supabase 역할 분담 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 변경 이력 |
| [docs/TODO.md](docs/TODO.md) | 남은 작업, 알려진 문제 |
| `graphify-out/GRAPH_REPORT.md` | 코드베이스 구조/커뮤니티 요약(Graphify 산출물) |

## 자주 쓰는 명령

```bash
npm run dev              # 개발 서버
npm run build            # 프로덕션 빌드 + TypeScript 타입체크 (커밋 전 필수)
npm run lint             # 현재 설정 파일 부재로 실패함 (확인됨) — 6번 규칙 참고
git status                # 작업 전/커밋 전 항상 확인
graphify explain "app/reservation/page.tsx"   # 특정 파일의 연결 관계 설명
graphify path "A" "B"                          # 두 파일/심볼 사이 영향 경로
graphify update .                              # 코드 변경 후 그래프만 빠르게 갱신(LLM 미사용)
```
