# WORKFLOW

이 프로젝트는 여러 도구를 조합해 개발합니다. 각 도구가 맡는 역할과, 도구 사이에 정보가 어떤 형태로
전달되는지를 정리한 문서입니다. 도구를 바꿔가며 작업할 때 "이 정보를 어디서 가져와서 어디에 넘겨야 하는지"
헷갈리지 않도록 하는 것이 목적입니다.

작업 절차 자체(단계별 순서)는 [docs/AI_PLAYBOOK.md](./AI_PLAYBOOK.md)를, 규칙은 [CLAUDE.md](../CLAUDE.md)를 참고하세요.

## 전체 흐름 한눈에 보기

```
[NotebookLM]              [ChatGPT]
요구사항/기획 정리          설계 검토 · 코드 리뷰 · 위험 분석
      │                          │
      ▼                          ▼
              사람이 요약해서 프롬프트로 전달
                          │
                          ▼
                  [Claude Code] ◀──── [Graphify] (graphify-out/)
                  실제 구현 · 테스트      코드 관계·영향 범위 분석
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
      로컬 개발(npm run dev)        [GitHub]
              │                버전 관리 (git commit / push)
              │                       │
              │                       ▼
              │                  [Vercel] (연동 확인 필요)
              │                  자동 빌드 · 프로덕션 배포
              │                       │
              └───────────┬───────────┘
                          ▼
                     [Supabase]
         DB · Auth · Storage · Realtime — 로컬 개발과 배포된 앱이 공통으로 접근하는 백엔드
```

## 도구별 역할

### NotebookLM — 요구사항·기획·문서 분석
- **역할**: 기획 문서, 회의록, 참고 서비스(하이파이브/스튜디오메이트/다짐 등) 자료를 모아 요구사항을 정리하고 질문에 답하는 용도.
- **입력**: 프로젝트 관련 문서, PDF, 회의록 등 비정형 자료.
- **출력**: 요구사항 요약, 기능 정의, 정책 결정 사항.
- **Claude Code로 전달하는 방법**: NotebookLM의 출력은 요구사항 초안일 뿐 이 저장소의 실제 코드 상태를 모릅니다.
  사람이 요약해서 Claude Code에 프롬프트로 전달하고, Claude Code는 이를 [docs/AI_PLAYBOOK.md](./AI_PLAYBOOK.md)
  "기능 개발 → 1-1. 요구사항 확인" 단계에 따라 [docs/REQUIREMENTS.md](./REQUIREMENTS.md)와 대조해 재검증합니다.
  NotebookLM의 결론을 그대로 구현 계획으로 쓰지 않습니다.

### ChatGPT — 설계 검토·코드 리뷰·위험 분석
- **역할**: Claude Code가 세운 구현 계획이나 작성한 코드를 독립적인 관점에서 재검토. 특히 이 프로젝트처럼
  API 서버 없이 RLS만으로 접근을 통제하는 구조는 설계 실수의 대가가 크므로, 권한/보안 관련 변경은 2차 검토가 유용합니다.
- **입력**: Claude Code가 만든 계획서, diff, 또는 특정 SQL/RLS 정책.
- **출력**: 위험 요소, 놓친 엣지 케이스, 대안 설계.
- **Claude Code로 전달하는 방법**: ChatGPT의 리뷰 결과를 사람이 Claude Code 대화에 붙여넣고, Claude Code는 그 지적이
  실제 코드/스키마에 해당하는지 검증한 뒤에만 반영합니다(ChatGPT도 이 저장소의 실시간 상태를 모르는 외부 도구이므로,
  일반론적인 지적을 이 코드베이스의 구체적 사실인 것처럼 그대로 받아들이지 않습니다).

### Graphify — 코드 관계와 영향 범위 분석
- **역할**: 저장소 전체를 스캔해 파일/모듈 간 관계 그래프를 만들고, 어떤 파일을 고치면 무엇이 영향받는지 빠르게 파악하게 해줍니다.
- **산출물 위치**: `graphify-out/`
  - `GRAPH_REPORT.md` — 커뮤니티(기능 단위 클러스터) 요약, 사람이 읽는 개요
  - `graph.json` — 노드/엣지 원본 데이터
  - `graph.html` — 브라우저에서 여는 인터랙티브 시각화
- **명령**:
  ```bash
  graphify update .          # 코드 변경 후 그래프만 빠르게 재추출 (LLM 미사용, 무료)
  graphify cluster-only .    # 커뮤니티 분류·리포트까지 재생성 (LLM 호출, 비용 발생)
  graphify explain "app/reservation/page.tsx"   # 특정 파일/심볼의 연결 관계 설명
  graphify path "reservations.ts" "reservation/page.tsx"   # 두 지점 사이 영향 경로
  ```
  - `graphify path`는 `lib/`/`app/` 같은 디렉터리 접두사가 붙으면 노드를 못 찾는 경우가 있어(확인됨) 파일명만 넣는 것이 안전합니다.
- **Claude Code와의 관계**: Claude Code가 복잡한 변경을 시작하기 전에 직접 CLI로 조회하는 **입력 도구**입니다
  (CLAUDE.md 규칙 2, 10). 코드 구조가 바뀌면 Claude Code가 그래프 최신화가 필요한지 판단해 사용자에게 확인합니다.

### Claude Code — 실제 구현과 테스트
- **역할**: 위 세 도구(NotebookLM/ChatGPT/Graphify)에서 나온 정보를 종합해 실제로 코드를 작성·수정하고,
  `npm run build`/수동 테스트로 검증한 뒤 문서(`docs/CHANGELOG.md`, `docs/TODO.md` 등)를 갱신하고 Git에 커밋하는 주체입니다.
- **입력**: 사람이 정리해서 전달하는 요구사항/리뷰 결과, Graphify 조회 결과, 저장소의 코드와 `docs/*.md`.
- **출력**: 코드 변경, 문서 갱신, Git 커밋(push는 사용자 명시 요청 시에만).
- **규칙**: [CLAUDE.md](../CLAUDE.md) 전체, 절차는 [docs/AI_PLAYBOOK.md](./AI_PLAYBOOK.md).

### GitHub — 버전 관리
- **역할**: 이 저장소(`sonjw222/booking-app`)의 코드/문서/SQL 마이그레이션의 단일 진실 공급원(source of truth).
  커밋 이력이 곧 변경 이력입니다(단, 이 저장소는 초기 개발 이력이 `Initial commit` 하나에 뭉쳐 들어가 있어
  세부 이력은 [docs/CHANGELOG.md](./CHANGELOG.md)에 별도로 재구성해 둔 상태 — 앞으로는 작은 단위 커밋으로 이력 자체가 신뢰 가능하도록 유지).
- **Claude Code와의 관계**: Claude Code가 `git add`/`git commit`을 실행하는 대상. `git push`로 원격에 반영되면
  (Vercel이 연동되어 있다면) 다음 도구(Vercel)의 자동 배포가 트리거되는 구성입니다 — 아래 Vercel 절의 확인 필요 사항 참고.

### Vercel — 자동 배포
- **역할(의도된 흐름)**: GitHub의 `main` 브랜치(또는 연결된 브랜치)에 push되면 Next.js 앱을 자동으로 빌드·배포하는 것이
  목표하는 구성입니다.
- ⚠ **확인 필요**: 이 저장소에는 `vercel.json`이나 `.vercel/` 폴더가 없습니다(`.gitignore`에 `.vercel` 항목만 존재).
  다만 Vercel은 대시보드에서 GitHub 저장소를 연결하기만 해도 별도 설정 파일 없이 동작하므로, 이 부재가 곧
  "연동 안 됨"을 의미하지는 않습니다 — 실제 연동 여부와 배포 브랜치는 Vercel 대시보드에서 직접 확인하세요.
  아직 연동 전이라면 이 절은 향후 구성 예정인 흐름으로 읽으면 됩니다.
- **Claude Code와의 관계**: Claude Code는 Vercel을 직접 조작하지 않습니다 — `npm run build`가 로컬에서 성공해야
  Vercel 빌드도 성공할 가능성이 높으므로, 커밋 전 로컬 빌드 통과가 사실상 배포 게이트 역할을 합니다(CLAUDE.md 규칙 7).
  Vercel 환경변수(Supabase URL/키 등)는 Vercel 대시보드에서 별도로 관리하며, 코드/Git에는 절대 포함하지 않습니다(CLAUDE.md 규칙 5).

### Supabase — DB, 인증, 스토리지
- **역할**: Postgres 데이터베이스, 이메일/소셜 인증, 파일 스토리지(사업자등록증 등), Realtime(알림/채팅)을 제공하는 백엔드.
  이 프로젝트에는 별도 API 서버가 없어 프론트엔드(`lib/*.ts`)가 Supabase JS 클라이언트로 직접 접근하고, RLS가 유일한
  서버측 접근 통제입니다([docs/DATABASE.md](./DATABASE.md) 참고).
- **Claude Code와의 관계**: 스키마 변경은 Claude Code가 SQL migration 파일(`add_*.sql`/`fix_*.sql`)로 작성하고,
  실제 Supabase 프로젝트에 대한 실행은 사용자(또는 승인된 절차)가 Supabase SQL Editor에서 수행합니다.
  Claude Code가 Supabase MCP 등으로 직접 실행 권한을 가진 경우에도, 파괴적 작업은 CLAUDE.md 규칙 3에 따라 항상 사용자 승인을 먼저 받습니다.

## 정보 전달 원칙

- **문서화되지 않은 정보는 다음 세션에 이어지지 않습니다.** NotebookLM/ChatGPT에서 얻은 중요한 결정은 반드시
  관련 `docs/*.md`에 반영해야 다음에 Claude Code가 이어받을 수 있습니다.
- **외부 도구의 산출물은 항상 이 저장소의 실제 코드로 재검증합니다.** NotebookLM/ChatGPT는 이 코드베이스를 실시간으로
  보고 있지 않으므로, "~라고 되어 있다더라" 식의 정보를 코드/스키마 확인 없이 그대로 반영하지 않습니다.
- **Graphify는 코드가 바뀌면 낡습니다.** 큰 구조 변경 후에는 그래프가 최신인지 항상 의심하고 필요시 갱신합니다.
- **Supabase가 최종 진실입니다.** `docs/DATABASE.md`나 `schema.sql`이 실제 운영 중인 Supabase 프로젝트의 스키마와
  다를 수 있으므로, 운영 데이터에 영향을 주는 작업 전에는 가능하면 실제 스키마를 재확인합니다.
