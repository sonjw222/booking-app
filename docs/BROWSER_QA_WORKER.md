# 브라우저 QA 워커 현황 (Issue #221) — 2026-10-25 현행화

이 문서는 PR #222 의 설계 문서(`docs/BROWSER_QA_WORKER_20261013.md`, 병합되지 않음)를 **현재 실제 구현을 확인한 뒤** 다시 쓴 것이다. 설계 문서는 "구현 코드·Mac 설치·ntfy 없음"을 전제했지만, 그 뒤 로컬 자동화 폴더에 QA 워커가 구현·설치되어 있다. 아래는 코드·테스트·설정 파일을 직접 읽고 확인한 사실만 적는다. **설치·실행·ntfy 수신이 이 이슈의 완료 조건을 충족한다는 증거는 아니다**(마지막 절 참고).

## 1. 현재 위치와 범위
- 구현은 이 저장소가 아니라 로컬 자동화 폴더에 있다: `~/Documents/mwhabit-automation/agent/qa_agent/*.py`(orchestrator·safety·browser·analysis·publish·report·state·issues·worktree·config), 진입점 `agent/run_qa_tasks.py`, 알림 `notify/qa_monitor.py`, 설치 `agent/install_qa_agent.sh`, 템플릿 `agent/templates/`. 저장소(`tools/mwhabit-dev-agent`)에는 개발 에이전트만 있다. **QA 워커 소스를 저장소로 옮길지는 미결정**(로컬 경로·설정이 섞여 있어 별도 PR 로 분리 필요).
- 개발 에이전트와 분리: 별도 라벨(`ai-qa-approved`), 별도 잠금(`qa_agent.lock`)·상태(`qa_state/`)·로그(`logs/qa/`)·kill switch(`agent/QA_AGENT_DISABLED`).

## 2. 안전 경계 — 코드에서 확인한 것
| 요구 | 구현 위치 | 확인 |
|---|---|---|
| 승인 라벨 정확 일치·작성자 allowlist·열린 Issue | `issues.is_eligible/is_approved`(작성자=`cfg.owner`, 라벨=`ai-qa-approved`) | 단위 테스트 `test_eligibility` |
| **라벨 부착자** 확인 | `issues.verify_labeler`(Issue 이벤트 API 의 마지막 `labeled` actor) | `test_labeler_check` |
| 비신뢰 입력 | `parse_directives` 는 `viewports/themes/scenarios` 화이트리스트 값만 읽고 나머지 텍스트는 실행에 쓰지 않음 | `test_directives_whitelist_only`(명령 주입 문자열 무시) |
| 단일 실행 | `qa_agent.lock`, 개발 에이전트 실행 중이면 상태 변경 없이 건너뜀 | `test_lock_prevents_concurrent_qa_runs`, `test_dev_agent_busy_skips_without_state_change` |
| 시간·비용 한도 | `max_run_seconds=2700`, `playwright_timeout_sec=900`, `claude_timeout_sec=900`, `claude_max_budget_usd=3.0`(0~20 검증), `max_fix_rounds=1`, `max_runs_per_day=3`(승인 Issue 는 일일 한도 면제이지만 다른 게이트 유지) | config `validate()`, `test_approved_issue_bypasses_daily_limit`, `test_bypass_keeps_other_gates` |
| kill switch | `QA_AGENT_DISABLED` 파일, `enabled=false` 기본 | `test_disabled_and_kill_switch` |
| 운영 타깃 차단 | 운영 project ref·DEV ref 를 **코드에 고정**(설정으로 변경 불가), `.env.test.local`/`.env.local` URL·JWT claim 검증, 서버 번들 스캔, 브라우저는 운영 호스트를 `--host-resolver-rules` 로 차단, 서버 포트 3200 고정 | `test_production_url_blocked`, `test_production_jwt_blocked`, `test_served_bundle_scan`, `test_playwright_assets_block_production_and_use_port_3200`, `test_preflight_blocks_on_production_env` |
| 비밀 마스킹 | 로그/보고서 출력에 `redact()` 적용, `.env.local` 은 공개 URL+anon 키만(service role 미전달) | `test_env_local_must_be_public_only`, `test_server_env_has_only_public_values` |
| 자동 수정 범위 | Claude 도구는 Read/Glob/Grep/Edit/Write 만(Bash 거부), `app/`·`tests/` 만, 인증·결제·예약 핵심(`lib/**`, `app/api/**` 등)·SQL·설정은 보류, 파일 10개/400줄 상한, 열린 Work PR 와 겹치면 보류 | `test_fix_violations`, `claude-dev.json` |
| 실패 후 자동 재시도 금지 | 실패 상태는 `ack`/`reset` 전까지 정지(`halt_on_unacked_failure`), 중단된 실행은 재개하지 않고 failed 처리 | `test_halts_on_unacked_failure`, `test_interrupted_run_becomes_failed_not_resumed` |
| 변경성 시나리오 | 회원/관리자/예약 시나리오는 DEV 데이터를 바꾸므로 `allow_mutating_scenarios` 승인 전에는 "미실행" 보고 | `test_mutating_groups_not_run_by_default` |
| 알림 중복 방지 | `qa_monitor` 가 상태 이력을 읽어 이벤트마다 한 번만 전송(커서 파일), 전송 실패는 유실이 아니라 재시도, 시스템 경고는 6시간에 한 종류 1회, 메시지에 토픽 미포함 | `test_each_event_sent_once_in_order`, `test_failed_send_is_retried_not_lost`, `test_message_never_contains_topic`, `test_system_alert_throttled` |

이 표의 "확인"은 `python3 -m unittest tests.test_qa_agent`(agent 폴더, 56건)를 2026-10-25 에 실행한 결과 **56 passed**(가짜 셸/가짜 전송 사용 — 실제 GitHub·ntfy·브라우저 호출 없음)에 근거한다.

## 3. 현재 설정 상태 (실행하지 않음)
- `qa_agent.config.json`: `enabled=false`, `publish_enabled=false`, `allow_mutating_scenarios=true`. 즉 **지금은 자동 실행·게시가 꺼져 있다**. (`allow_mutating_scenarios=true` 는 켜는 순간 DEV 데이터를 바꾸는 시나리오가 허용된다는 뜻이므로 `enabled` 를 켜기 전에 다시 결정할 항목.)
- `agent/CLAUDE_AUTO_DISABLED` 가 있다(2026-10-15 "수동 Claude Code 프롬프트 인계만" 사용자 요청). `QA_AGENT_DISABLED` 는 없다.
- LaunchAgent 가 설치돼 있다: `com.mwhabit.claude-qa-agent`, `com.mwhabit.qa-notify`(알림 감시기). 이 작업에서 `launchctl` 로 시작/중지하지 않았고, 워커를 실행하지 않았고, ntfy 를 보내지 않았다.
- 과거 상태 파일: `qa_state/qa-issue-202|204|207.json`(이전에 처리한 Issue 의 상태·PR 계획), `qa_notification_state.json` 에 해당 Issue 의 이벤트 전송 횟수 커서가 있다. 휴대폰 **수신**은 이 파일로 증명되지 않는다.

## 4. 이슈 #221 완료 조건 대조
| 완료 조건 | 현재 증거 | 판정 |
|---|---|---|
| 승인 라벨·작성자/명령 allowlist·단일 실행 | 코드+단위 테스트(위 표) | **코드 확인됨** |
| 시간/비용 한도·kill switch | 코드+단위 테스트 | **코드 확인됨** |
| 운영 타깃 차단 | 코드+단위 테스트(고정 ref, 번들 스캔, 호스트 차단) | **코드 확인됨**(실제 Chromium 에서 호스트 차단이 작동하는지는 미실행) |
| 비밀 마스킹 | `redact` 적용 코드 | **부분 확인**(전체 출력 경로 감사는 하지 않음) |
| 알림 중복 방지 | 코드+단위 테스트 | **코드 확인됨** |
| 설치 | LaunchAgent plist 존재 | **설치 흔적 확인, 동작 확인 아님** |
| 실제 실행(라벨 → 브라우저 QA → 보고) | 과거 Issue 202/204/207 상태 파일 | **#219/#220 같은 이번 건에 대한 실행 증거 없음** |
| ntfy 실제 수신 | 전송 커서만 있음 | **미검증**(수신 확인은 사용자 기기에서만 가능) |

→ #221 은 **완료 처리하지 않고 OPEN 유지**한다. 남은 일: ① `enabled=true` 로 켜기 전 사용자 결정(변경성 시나리오 허용 여부, 일일 한도), ② 라벨 부착 → 실행 → Draft PR → ntfy 의 실제 1회 통과 증거, ③ 사용자 기기에서 ntfy 수신 확인, ④ (선택) 소스를 저장소로 이전.

## 5. 알림이 오지 않을 때 점검 (설계 문서 §4 를 현행화)
토픽·토큰 값을 화면/로그에 붙여넣지 않는다.
1. `launchctl print gui/$(id -u)/com.mwhabit.qa-notify | head -30` 로 로드·마지막 종료 코드 확인(감시기는 주기 실행이라 평소 `-` 상태일 수 있음).
2. `notify/launchd.stdout.log`/`launchd.stderr.log` 마지막 줄에서 오류 확인.
3. `agent/qa_state/qa-issue-N.json` 의 `history` 에 새 상태가 실제로 쌓였는지, `notify/qa_notification_state.json` 커서가 그 개수를 따라가는지 비교(커서가 이미 같으면 "이미 보냄"으로 건너뜀).
4. 시스템 경고(권한 오류 등)는 6시간에 한 종류만 보낸다.
5. 서버 경로: 사용자가 직접 `curl` 로 토픽에 테스트 메시지를 보내 HTTP 200 확인 → 200 인데 안 오면 휴대폰의 ntfy 앱 구독·알림 권한·방해금지 문제.
6. 개발 에이전트(`com.mwhabit.dev-notify`) 와 QA 감시기는 서로 다른 상태·커서를 쓴다.

## 6. #219 와의 관계
관리자 센터 페이지네이션 실브라우저 검증 절차는 `docs/qa/admin-pagination-live.md` 에 있다. 이 워커의 `admin` 시나리오 그룹과 별개로, 2026-10-25 에 격리 PostgreSQL 환경에서 ON/OFF 검증을 수행했다(PR 설명 참고) — 그것은 DEV 검증이 아니다.
