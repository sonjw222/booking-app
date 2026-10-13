# 브라우저 QA 워커 및 ntfy 알림 경로 설계 (Issue #221, 설계/가이드 단계)

상태: **설계·절차 문서만 포함. 구현 코드(런처/워커)·Mac 설치·실브라우저 QA·ntfy 발송은 수행/검증하지 않았다.**
SQL 필요: NO. SQL 경로/순서/전문 없음.

## 1. 기존 에이전트 조사 결과 (`tools/mwhabit-dev-agent`, 변경 없음)

| 항목 | 현재 동작 | 근거 |
| --- | --- | --- |
| 도구 | Claude tools는 Read/Glob/Grep/Edit/Write만, Bash/MCP 없음 | `dev_agent/claude_runner.py` |
| 비용 | `claude_max_budget_usd` 기본 2, 0 초과 20 이하 검증 | `dev_agent/config.py` |
| 승인 | 라벨 `ai-dev-approved`, 작성자 `sonjw222`, 열린 Issue, 동시 1개/잠금 | `config.py`, README |
| 차단 | `DEV_AGENT_DISABLED` 파일(kill switch), `enabled`/`publish_enabled` 기본 false | `config.py` |
| 게시 | Draft PR만, 강제 push/merge 없음, 게시 직전 라벨/작성자/본문 SHA 재검증 | `publish.py` |
| 알림 | 저장소 내 ntfy 코드 **없음**(grep 0건). README도 푸시 기능 없음을 명시 | README |

결론: 브라우저 실행은 Bash/네트워크가 필요하므로 기존 에이전트에 합치면 권한 완화가 된다. **별도 워커로 분리**한다. 기존 에이전트의 설정·도구·라벨·한도는 이 작업에서 변경하지 않는다.

## 2. QA 워커 설계 (별도 디렉터리, 별도 LaunchAgent)

권장 위치(코드 PR은 별도 승인 후): `tools/mwhabit-browser-qa/`. 이 Issue 실행 에이전트는 `tools/` 수정 권한이 없어 구현하지 않았다.

- **분리**: 별도 설정 파일, 별도 state/log 디렉터리, 별도 LaunchAgent 라벨(`com.mwhabit.browser-qa`). 개발 에이전트와 설정/토큰/state를 공유하지 않는다.
- **승인**: 라벨 `ai-browser-qa-approved` 정확 일치, 작성자 allowlist(`sonjw222`), 열린 Issue만. 개발 라벨 `ai-dev-approved`로는 실행되지 않는다(반대도 동일).
- **비신뢰 입력**: Issue 본문은 대상 allowlist 선택에 쓰지 않는다. 실행 가능한 QA 시나리오는 **저장소의 사전 정의된 시나리오 ID 목록**(allowlist)에서만 고르고, Issue 본문의 명령/URL/경로는 무시한다. 시나리오 ID는 Issue 번호와 매핑한 설정 파일로 지정한다.
- **잠금/kill switch**: 단일 실행 잠금 파일, `BROWSER_QA_DISABLED` 파일이 있으면 즉시 종료. `enabled` 기본 false.
- **한도**: 전체 실행 시간 상한(예: 20분), 시나리오별 타임아웃, 재시도 최대 1회, 상태 `queued → running → passed | failed | blocked`, 실패 후 자동 재시도 없이 사람이 확인(`halt_on_unacked_failure` 동일 방식). Claude를 사용할 경우 비용 상한은 기존보다 낮게(예: 1 USD) 별도 설정.
- **환경 제한**: 대상 URL은 `http://localhost:*` 또는 설정에 명시된 DEV/Preview 호스트 allowlist만. 운영 도메인/운영 Supabase 프로젝트 ref가 설정·환경변수에 있으면 시작 거부. 결제·SQL 적용·PR 병합 단계는 코드에 존재하지 않는다.
- **자격증명**: DEV 테스트 계정은 Mac Keychain 또는 `chmod 600` 로컬 env 파일에서만 읽고 저장소/Issue/PR/로그에 쓰지 않는다. 스크린샷 전 입력란 마스킹, trace는 `screenshots/snapshots` 포함 시 로컬 보관만 하고 GitHub에 첨부하지 않는다. 로그 출력 전 토큰/이메일/전화 패턴 마스킹.
- **로그인 불가/환경 불가**: PASS 금지. 결과는 `BLOCKED`와 사유를 기록.

## 3. 증거 기록 형식 (매 실행)

실행 시각(UTC/KST), commit SHA, 환경(로컬/DEV/Preview URL 호스트만), 실행 명령, 시나리오별 PASS/FAIL/BLOCKED, 콘솔·네트워크 오류 수, 아티팩트 경로(로컬 `…/browser-qa/artifacts/issue-N/<timestamp>/`), 마스킹 적용 여부. Issue 댓글/Draft PR 본문에는 요약과 경로만 게시하고 이미지/trace 원본은 올리지 않는다.

## 4. ntfy 경로 설계

- 송신은 Mac 로컬 워커에서만. topic/token은 Keychain 또는 `chmod 600` env(`NTFY_TOPIC`, `NTFY_TOKEN`)에서 읽고, 설정 JSON·GitHub·로그에는 쓰지 않는다. 로그에는 topic을 `abc…` 마스킹 형태로만 표시.
- 이벤트: `started`, `completed`, `blocked`, `failed`. 본문에는 Issue 번호, 상태, commit 앞 7자리만. Issue 본문/계정 정보는 넣지 않는다.
- **중복 방지**: 키 `issue-N:<commit7>:<event>`를 state에 기록하고 이미 `sent`이면 재전송하지 않는다. 전송 성공(HTTP 2xx) 후에만 기록한다.
- **실패 진단**: 전송 실패는 작업 결과를 바꾸지 않고 state에 `notify_error`(HTTP 코드/예외 종류, 시각)만 남기고 다음 실행에서 `pending` 건을 최대 3회 재시도.

### 알림이 오지 않을 때 점검 절차 (#219/#220 사례 재현용)

모든 단계에서 topic/token 값을 화면·로그에 붙여넣지 않는다.

1. 저장소 확인: 현재 main에는 ntfy 송신 코드가 없다. `grep -ri ntfy tools app lib` 결과가 0건이면 "알림이 오지 않는 것이 정상"이다(원인 1순위). 기존 에이전트 README도 푸시 미지원이라고 명시한다.
2. 워커 상태: `launchctl print gui/$(id -u)/com.mwhabit.browser-qa | head -30`로 로드/마지막 종료 코드 확인. 기존 에이전트는 해당 전용 LaunchAgent 라벨로 동일 확인.
3. 로그: 전용 launchd stdout/stderr 로그 마지막 50줄에서 `notify` 항목 확인.
4. kill switch/설정: `DEV_AGENT_DISABLED`, `BROWSER_QA_DISABLED` 파일 존재 여부, `enabled`/`publish_enabled` 값.
5. 환경변수: launchd는 로그인 셸 환경을 상속하지 않는다. `NTFY_TOPIC`/`NTFY_TOKEN`이 plist 또는 Keychain 조회로 주입되는지 "설정됨/없음"만 확인한다.
6. 수동 송신 테스트(사용자가 직접): `curl -sS -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $NTFY_TOKEN" -d "test" "https://ntfy.sh/$NTFY_TOPIC"` → 200이면 서버 경로 정상.
7. 휴대폰: ntfy 앱의 동일 topic 구독, 앱 알림 권한/방해금지/배터리 최적화 확인. 200인데 안 오면 앱 쪽 문제.
8. 중복 방지 state에 이미 `sent`로 표시되어 재전송이 건너뛰어졌는지 확인.

## 5. 설치/활성화 (기본 OFF, 각 단계 사용자 승인)

1. 코드 PR 리뷰·병합(사람). 이 문서 PR은 설계/가이드만 포함.
2. Mac에서 `enabled=false`로 소스 복사, 설정 검증 명령만 실행.
3. Playwright/Chromium 설치는 사용자가 수동 실행(`npx playwright install chromium`; package.json 변경 필요 여부는 별도 PR에서 승인).
4. DEV 테스트 계정/ntfy 비밀값을 Keychain 또는 600 env에 사용자가 직접 등록.
5. `ntfy` 수동 송신 테스트 → 시나리오 1건을 수동 실행 → 증거 확인 후에야 라벨 자동 실행과 LaunchAgent 활성화.
6. 상태 확인: `launchctl print …`, 로그 tail, state JSON, ntfy 점검 절차(4절).
7. 비활성화/복구: kill switch 파일 생성 → `launchctl bootout gui/$(id -u)/com.mwhabit.browser-qa` → 실패 state는 확인 후 수동 초기화, 잠금 파일이 오래되었으면(프로세스 없음 확인 후) 삭제.

설치 전: 아무 것도 실행되지 않는다. 설치 후(활성화 전): 설정 검증만 가능. 활성화 후: 라벨+작성자+allowlist 조건을 모두 만족한 Issue만 실행.

## 6. #219 관리자 페이지네이션 실브라우저 QA 절차

전제: 비운영 Supabase에 migration 적용 및 검증 완료(`ADMIN_CENTER_PAGINATION_20261011.md` 참조, 별도 승인), DEV 관리자 테스트 계정 준비, 로컬/DEV 빌드. 전제 미충족이면 전부 **BLOCKED**.

두 빌드로 각각 실행한다: (A) `NEXT_PUBLIC_ADMIN_CENTER_PAGINATION=true`, (B) 플래그 OFF(회귀).

| # | 시나리오 | 통과 기준 |
| --- | --- | --- |
| 1 | 회원/수업/예약 목록 첫 페이지 | 최대 30건 표시, 정렬 created_at DESC |
| 2 | 더 보기(페이지 이동) 반복 | 새 행 추가, 로딩/오류 상태 정상 |
| 3 | 첫·끝 경계 | 마지막 페이지에서 더 보기 비표시, 첫 페이지 재진입 시 동일 결과 |
| 4 | 검색/필터 | 300ms 후 조회, 탭/검색 유지, 이전 요청 역전 무시 |
| 5 | 빈 상태 | 결과 0건에서 빈 상태 문구, 오류 아님 |
| 6 | 중복/누락 | 전체 로드 후 행 id 집합에 중복 0, 기대 개수와 일치 |
| 7 | 콘솔/네트워크 | console error 0, 4xx/5xx 0(의도한 권한 거부 제외) |
| 8 | 승인/반려 후 갱신 | DEV 데이터에서만, 새 첫 페이지 조회 |
| 9 | 플래그 OFF 회귀(B) | 기존 RPC 사용, 클라이언트 페이지 분할, 위 1~7 동일 |

데이터 변경은 DEV 합성 데이터 한정이며 운영 로그인/결제는 수행하지 않는다. 결과는 3절 형식으로 Issue #219에 댓글로 보고한다.

## 7. 테스트/회귀

- 기존 에이전트 회귀: `python3 -m unittest discover -s tools/mwhabit-dev-agent/tests` (README 기준 51건). 이 작업은 해당 코드를 변경하지 않았으므로 실행하지 않았다.
- 신규 워커 코드가 추가되면 동일 방식의 단위 테스트(라벨/작성자/잠금/kill switch/운영 URL 거부/BLOCKED 판정/ntfy 중복 방지/비밀 마스킹)를 함께 제출해야 한다.

## 8. 미수행/한계

- 워커 코드·테스트·LaunchAgent plist 미구현(`tools/`, 설정, `.github/` 수정 권한 밖).
- Mac 설치, 실 Chromium QA, ntfy 실제 발송 모두 **미검증**. 따라서 Issue #221은 완료가 아니다.
- #219 실브라우저 QA는 비운영 DB 지정 및 SQL 적용 승인 대기로 BLOCKED.
