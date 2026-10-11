from __future__ import annotations

import fcntl
import logging
from pathlib import Path

from . import checks as checks_mod
from . import claude_runner, guard, issues, publish as publish_mod, worktree as wt_mod
from .config import KILL_SWITCH, LOCK_PATH, Config
from .state import StateStore
from .util import Shell, get_logger, log


class SkipRun(Exception):
    """정상적인 건너뜀(비활성, 잠금, 작업 없음 등). 실패가 아니다."""


def acquire_lock(path: Path = LOCK_PATH):
    handle = Path(path).open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise SkipRun("다른 자동 개발 작업이 실행 중입니다(동시 실행 방지).")
    return handle


def run_once(cfg: Config, shell=None, kill_switch: Path = KILL_SWITCH, lock_path: Path = LOCK_PATH,
             logger: logging.Logger | None = None) -> dict:
    """대기 중인 승인 Issue 하나를 처리한다. 반환: {'outcome': ..., 'issue': N, ...}"""
    shell = shell or Shell()
    if not cfg.enabled:
        return {"outcome": "disabled"}
    if Path(kill_switch).exists():
        return {"outcome": "kill_switch"}
    logger = logger or get_logger(Path(cfg.logs_dir))
    try:
        lock = acquire_lock(lock_path)
    except SkipRun as exc:
        return {"outcome": "locked", "message": str(exc)}
    try:
        store = StateStore(Path(cfg.state_dir))
        for n in store.recover_interrupted():
            log(logger, logging.WARNING, f"Issue #{n}: 이전 실행이 중단되어 failed 처리했습니다(자동 재개 없음).")
        if cfg.halt_on_unacked_failure:
            pending = store.unacked_attention()
            if pending:
                nums = ", ".join(f"#{d['issue']}({d['status']})" for d in pending)
                return {"outcome": "halted", "message": f"확인되지 않은 실패/차단 작업이 있어 중단: {nums} — `ack` 또는 `reset` 필요"}
        issue = issues.select_next(issues.fetch_open_labeled(cfg, shell), cfg, store)
        if issue is None:
            return {"outcome": "no_work"}
        return process_issue(cfg, shell, store, issue, logger)
    finally:
        lock.close()


def process_issue(cfg: Config, shell, store: StateStore, issue: dict, logger: logging.Logger) -> dict:
    n = issue["number"]
    state = store.create(n, title_sha256=issues.sha256(issue.get("title", "")), body_sha256=issues.sha256(issue.get("body", "")),
                         title=(issue.get("title") or "")[:cfg.max_issue_title_chars])
    attempt = state["attempt"]
    log(logger, logging.INFO, f"Issue #{n} 시작 (시도 {attempt})")
    stage = "worktree"
    try:
        info = wt_mod.create_worktree(cfg, shell, n, attempt)
        store.update(n, worktree=info["path"], branch=info["branch"], base_sha=info["base_sha"])
        store.update(n, deps=wt_mod.link_node_modules(cfg, shell, info["path"]))

        stage = "settings"
        import json, os
        settings = claude_runner.build_settings(cfg, os.environ.get("HOME", "/"), info["path"])
        settings_path = Path(cfg.state_dir) / f"issue-{n}.run-settings.json"
        settings_path.write_text(json.dumps(settings, indent=2))

        stage = "claude"
        before = guard.snapshot_source(cfg, shell)
        store.update(n, "claude_running")
        run = claude_runner.run_claude(cfg, shell, issue, info["path"], settings_path)
        store.update(n, "validating", claude={k: v for k, v in run.items() if k != "summary"}, summary=run.get("summary", ""))
        if run.get("returncode") != 0 or run.get("is_error") or run.get("error"):
            store.fail(n, "claude", f"Claude Code 실행 실패: {run.get('subtype') or run.get('error') or run.get('returncode')}")
            return {"outcome": "failed", "issue": n, "stage": "claude"}

        stage = "guard"
        after = guard.snapshot_source(cfg, shell)
        if before != after:
            store.fail(n, "guard", "원본 저장소 상태가 실행 중 바뀜(다른 작업과 겹쳤거나 격리 위반) — 사람이 확인 필요", blocked=True)
            return {"outcome": "blocked", "issue": n, "stage": "guard"}
        verdict = guard.validate(cfg, shell, info["path"], info["base_sha"], info["branch"])
        store.update(n, changed_files=verdict["files"], changed_lines=verdict["changed_lines"])
        if not verdict["ok"]:
            store.fail(n, "guard", "; ".join(verdict["problems"]), blocked=True)
            return {"outcome": "blocked", "issue": n, "stage": "guard", "problems": verdict["problems"]}

        stage = "checks"
        store.update(n, "testing")
        result = checks_mod.run_checks(cfg, shell, info["path"])
        store.update(n, checks=result)
        if not result["ok"]:
            store.fail(n, "checks", "검증 실패: " + next(c["name"] + " — " + c["detail"] for c in result["results"] if not c["ok"]))
            return {"outcome": "failed", "issue": n, "stage": "checks"}

        stage = "commit"
        store.update(n, "committing")
        sha = publish_mod.commit_changes(cfg, shell, info["path"], verdict["files"], issue, info["base_sha"])
        state = store.load(n)
        plan = publish_mod.build_pr_plan(cfg, issue, state, sha, verdict["files"], result, state.get("summary", ""))
        plan_path, body_path = publish_mod.write_plan(Path(cfg.state_dir), plan)
        store.update(n, "ready_for_pr", commit=sha, pr_plan=str(plan_path), pr_body=str(body_path))
        log(logger, logging.INFO, f"Issue #{n}: 로컬 커밋과 PR 계획 준비 완료(push/PR 생성 안 함).")
        return {"outcome": "ready_for_pr", "issue": n, "commit": sha, "plan": str(plan_path)}
    except Exception as exc:  # 어떤 단계든 실패하면 자동 재시도 없이 보고한다
        store.fail(n, stage, f"{type(exc).__name__}: {exc}")
        log(logger, logging.ERROR, f"Issue #{n} 실패({stage}): {type(exc).__name__}: {exc}")
        return {"outcome": "failed", "issue": n, "stage": stage, "error": str(exc)}
