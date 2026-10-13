from __future__ import annotations

import json
from dataclasses import dataclass, fields
from pathlib import Path

BASE = Path("/Users/sonjw/Documents/mwhabit-automation")
AGENT = BASE / "agent"
CONFIG_PATH = AGENT / "dev_agent.config.json"
KILL_SWITCH = AGENT / "DEV_AGENT_DISABLED"
LOCK_PATH = AGENT / "dev_agent.lock"  # 읽기 전용 자동화(run_tasks.lock)와 별도 잠금


class ConfigError(Exception):
    pass


@dataclass
class Config:
    enabled: bool = False                      # 기본 비활성
    publish_enabled: bool = False              # push/PR 생성도 기본 비활성
    repo: str = "sonjw222/booking-app"
    owner: str = "sonjw222"
    label: str = "ai-dev-approved"             # 읽기 전용 자동화의 ai-task-approved 와 다름
    git_host_path: str = "/Users/sonjw/Documents/mwhabit-automation/git-host"   # worktree 등록용 git 저장소(작업 트리는 수정하지 않음)
    node_modules_source: str = "/Users/sonjw/Documents/mwhabit-automation/git-host/node_modules"
    worktrees_dir: str = str(BASE / "worktrees")
    state_dir: str = str(AGENT / "dev_state")
    logs_dir: str = str(BASE / "logs" / "dev")
    claude_settings: str = str(AGENT / "claude-dev.json")
    claude_bin: str = "claude"
    git_bin: str = "git"
    gh_bin: str = "gh"
    base_branch: str = "main"
    remote: str = "origin"
    branch_prefix: str = "ai-dev/issue-"
    claude_timeout_sec: int = 1200
    claude_max_budget_usd: float = 2.0
    checks_timeout_sec: int = 900
    max_files: int = 15
    max_changed_lines: int = 800
    max_file_bytes: int = 200_000
    max_issue_body_chars: int = 6000
    max_issue_title_chars: int = 200
    allowed_prefixes: tuple = ("app/", "lib/", "tests/", "docs/")
    halt_on_unacked_failure: bool = True
    tsc_baseline_test_errors: int = 49         # tests/ 안의 기존 tsc 오류 수(main 기준). 늘어나면 실패
    run_build: bool = True


def load_config(path: Path = CONFIG_PATH) -> Config:
    cfg = Config()
    if not path.exists():
        return cfg
    try:
        raw = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise ConfigError(f"설정 JSON 오류: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError("설정은 JSON 객체여야 합니다.")
    known = {f.name: f for f in fields(Config)}
    for key, value in raw.items():
        if key not in known:
            raise ConfigError(f"알 수 없는 설정 키: {key}")
        if key == "allowed_prefixes":
            value = tuple(value)
        setattr(cfg, key, value)
    validate(cfg)
    return cfg


def validate(cfg: Config) -> None:
    for key in ("enabled", "publish_enabled", "halt_on_unacked_failure", "run_build"):
        if not isinstance(getattr(cfg, key), bool):
            raise ConfigError(f"{key}는 true/false 여야 합니다.")
    if cfg.publish_enabled and not cfg.enabled:
        raise ConfigError("publish_enabled는 enabled가 true일 때만 켤 수 있습니다.")
    if cfg.label == "ai-task-approved":
        raise ConfigError("읽기 전용 자동화의 라벨(ai-task-approved)과 분리돼야 합니다.")
    if not cfg.label or not cfg.owner or "/" not in cfg.repo:
        raise ConfigError("repo/owner/label이 올바르지 않습니다.")
    if cfg.base_branch != "main" and cfg.base_branch.strip() == "":
        raise ConfigError("base_branch가 비어 있습니다.")
    if not (0 < cfg.claude_max_budget_usd <= 20):
        raise ConfigError("claude_max_budget_usd는 0 초과 20 이하여야 합니다.")
    if not (60 <= cfg.claude_timeout_sec <= 7200):
        raise ConfigError("claude_timeout_sec는 60~7200초여야 합니다.")
    base = BASE.resolve()
    for key in ("worktrees_dir", "state_dir", "logs_dir"):
        p = Path(getattr(cfg, key)).resolve()
        if base not in p.parents and p != base:
            raise ConfigError(f"{key}는 {base} 아래여야 합니다.")
    if Path(cfg.worktrees_dir).resolve() == Path(cfg.git_host_path).resolve():
        raise ConfigError("worktrees_dir가 원본 저장소와 같을 수 없습니다.")
    for pre in cfg.allowed_prefixes:
        if not pre.endswith("/") or pre.startswith("/") or ".." in pre:
            raise ConfigError(f"allowed_prefixes 항목이 올바르지 않습니다: {pre}")
