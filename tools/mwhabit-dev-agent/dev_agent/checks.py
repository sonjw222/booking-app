from __future__ import annotations

import re
import time

from .config import Config
from .util import minimal_env, redact

_TSC_ERR = re.compile(r"^(?P<file>[^\s(]+)\(\d+,\d+\): error TS\d+")


def parse_tsc(output: str) -> dict:
    app_errors, test_errors = [], 0
    for line in output.splitlines():
        m = _TSC_ERR.match(line)
        if not m:
            continue
        if m["file"].startswith("tests/"):
            test_errors += 1
        else:
            app_errors.append(line.strip()[:200])
    return {"app_errors": app_errors, "test_errors": test_errors}


def default_checks(cfg: Config) -> list[dict]:
    checks = [
        {"name": "git diff --check", "cmd": [cfg.git_bin, "diff", "--check"], "kind": "plain"},
        {"name": "unit tests (vitest)", "cmd": ["npx", "--no-install", "vitest", "run"], "kind": "plain"},
        {"name": "typecheck (tsc)", "cmd": ["npx", "--no-install", "tsc", "--noEmit", "-p", "."], "kind": "tsc"},
    ]
    if cfg.run_build:
        checks.append({"name": "production build", "cmd": ["npm", "run", "build"], "kind": "plain"})
    return checks


def run_checks(cfg: Config, shell, worktree: str, checks: list[dict] | None = None) -> dict:
    """하나라도 실패하면 즉시 중단한다. 실제 Supabase 값 대신 placeholder 환경변수만 사용한다."""
    env = minimal_env({"NEXT_PUBLIC_SUPABASE_URL": "https://placeholder.supabase.co",
                       "NEXT_PUBLIC_SUPABASE_ANON_KEY": "placeholder-anon-key", "CI": "1"})
    results, ok = [], True
    for check in checks if checks is not None else default_checks(cfg):
        started = time.time()
        try:
            r = shell.run(check["cmd"], cwd=worktree, env=env, timeout=cfg.checks_timeout_sec)
            passed, detail = r.returncode == 0, ""
            out = (r.stdout or "") + (r.stderr or "")
            if check.get("kind") == "tsc":
                parsed = parse_tsc(out)
                passed = not parsed["app_errors"] and parsed["test_errors"] <= cfg.tsc_baseline_test_errors
                detail = f"앱/lib 오류 {len(parsed['app_errors'])}건, tests 오류 {parsed['test_errors']}건(기준 {cfg.tsc_baseline_test_errors})"
                if parsed["app_errors"]:
                    detail += " | " + parsed["app_errors"][0]
            elif not passed:
                detail = redact(out)[-400:]
        except Exception as exc:  # 타임아웃 포함
            passed, detail = False, f"{type(exc).__name__}: {exc}"[:300]
        results.append({"name": check["name"], "ok": passed, "seconds": round(time.time() - started, 1), "detail": detail})
        if not passed:
            ok = False
            break
    return {"ok": ok, "results": results}
