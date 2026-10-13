# MWHABIT 제한형 자동 개발 에이전트

기존 Mac 에이전트의 검토 가능한 소스 스냅샷. 운영 state/log/token/settings 백업은 포함하지 않는다.
기본 설정 비활성. Mac 설치 대상 /Users/sonjw/Documents/mwhabit-automation/agent.
원본 /Users/sonjw/Documents/booking-app은 사용하지 않고 전용 git-host를 기본으로 한다.

- 열린 Issue + ai-dev-approved 정확한 라벨 + sonjw222 작성자만 실행, 한번에 1개/잠금.
- Claude tools Read/Glob/Grep/Edit/Write만, Bash/MCP 없음, worktree 범위만, API 비용 2 USD 상한.
- 검증/테스트/로컬 커밋 뒤 ready_for_pr. scheduled 명령은 별도 publish_enabled 설정이 켜진 경우 대기 1건을 Draft PR 게시.
- 게시 직전 Issue 라벨/작성자/본문 SHA 검증. kill switch DEV_AGENT_DISABLED 및 공용 잠금 적용.
- 기존 matching Draft PR은 URL 반환; 다른 commit/base/state의 PR은 차단. 강제 push/merge 없음.
- StateStore.all은 issue-[1-9][0-9]*.json 정규식만 읽음(부속/Unicode/0/선행0 제외).
- PR 본문에는 최종 검증 결과만 표시. Claude 중간 보고는 상태/로그에 보존.

테스트: `python3 -m unittest discover -s tools/mwhabit-dev-agent/tests` — 51건(외부 DB/Claude/GitHub API 호출 없음).
일부 테스트는 로컬 Git 임시 저장소를 사용한다.
Mac 설치 시 소스만 복사하며 dev_state/logs/기존 readonly 에이전트는 유지한다.

정기 실행: 전용 LaunchAgent 5분 간격 scheduled. 정상 결과는 전용 launchd 로그에 저장.
Codex 이 대화는 30분 heartbeat로 state·Draft CI를 확인하고 의미 있는 변화/승인 필요 시만 알린다.
휴대폰의 ChatGPT 알림 전달은 별도 모바일 앱 권한/계정 기능을 확인해야 한다.
이 소스에 로컬 로그를 ChatGPT Push API로 보내는 기능은 없다.

GitHub CLI keychain 인증을 전용 git-host credential helper에 연결한다. 토큰을 파일/PR/로그에 저장하지 않는다.
SQL 필요 NO. SQL 경로/순서/전문 없음.
