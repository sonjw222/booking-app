#!/usr/bin/env python3
"""Opt-in, isolated Claude-in-Chrome QA for MWHABIT #219. No production writes."""
from __future__ import annotations
import argparse
import base64
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

REPO = "sonjw222/booking-app"
ISSUE = 219
REF_PROD = "bxntqggkfwnhcczsbqtj"
APP_URL = "http://127.0.0.1:3199"
LABEL = "ai-browser-qa-approved"
ROOT = Path(__file__).resolve().parents[2]
STATE = Path.home() / "Documents/mwhabit-automation/browser-qa"
TEST_ENV = ROOT / ".env.test.local"
CHECKS = ("login", "first_page", "status_tabs", "search", "pagination_boundary", "no_duplicates", "console_network")
REQUIRED_TOOLS = ("navigate", "read_page", "read_console_messages", "read_network_requests")

class Blocked(Exception):
    pass

def read_env(path):
    if not path.is_file():
        raise Blocked("로컬 설정 파일 없음: " + path.name)
    if path.stat().st_mode & 0o077:
        raise Blocked("로컬 설정 chmod 600 필요: " + path.name)
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            raise Blocked("로컬 설정 파일 형식 오류")
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", key):
            raise Blocked("로컬 설정 변수명 오류")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key] = value
    return values

def validate_target(env, expected):
    raw = env.get("NEXT_PUBLIC_SUPABASE_URL", "")
    try:
        url = urlparse(raw)
    except ValueError:
        raise Blocked("Supabase URL 형식 오류") from None
    host = url.hostname or ""
    if url.scheme != "https" or not host.endswith(".supabase.co"):
        raise Blocked("DEV Supabase URL 미확인")
    project = host.split(".")[0]
    if not re.fullmatch(r"[a-z0-9]{20}", project):
        raise Blocked("Supabase project ref 형식 오류")
    if project == REF_PROD or project != expected:
        raise Blocked("운영/미승인 Supabase 프로젝트 접근 차단")
    for name in ("NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"):
        key = env.get(name, "")
        if not key:
            raise Blocked(name + " 미설정")
        parts = key.split(".")
        if len(parts) == 3:
            try:
                claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
            except (ValueError, TypeError):
                raise Blocked(name + " JWT 분석 실패") from None
            if claims.get("ref") != project:
                raise Blocked(name + "의 프로젝트와 URL 불일치")
    return project

def issue_is_approved():
    command = ["gh", "issue", "view", str(ISSUE), "--repo", REPO,
               "--json", "number,state,author,labels"]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise Blocked("GitHub issue 조회 실패")
    try:
        info = json.loads(result.stdout)
        return (info["number"] == ISSUE and info["state"] == "OPEN"
                and info["author"]["login"] == "sonjw222"
                and LABEL in {x["name"] for x in info["labels"]})
    except (ValueError, KeyError, TypeError):
        raise Blocked("GitHub issue 확인 실패") from None

def chrome_ready():
    bridge = (Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
              / "com.anthropic.claude_code_browser_extension.json")
    if not bridge.is_file():
        raise Blocked("Claude in Chrome 첫 연결 필요 (Mac에서 claude --chrome)")
    if not all(shutil.which(x) for x in ("claude", "npm", "gh", "git")):
        raise Blocked("Claude / npm / gh / git 중 누락")
    # Native host existence alone is NOT proof of Chrome auth or permission.

def parse_chrome_output(stdout):
    names = set()
    response = ""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    names.add(block.get("name", ""))
        if event.get("type") == "result":
            if event.get("is_error"):
                raise Blocked("Claude Code 실행 오류")
            response = str(event.get("result") or "")
    return response, names

def judge(response, names):
    for tool in REQUIRED_TOOLS:
        if "mcp__claude-in-chrome__" + tool not in names:
            return "BLOCKED", {}
    try:
        data = json.loads(response.strip())
        checked = {name: data["checks"].get(name) is True for name in CHECKS}
        if data.get("status") == "PASS" and all(checked.values()):
            return "PASS_REPORTED", checked
        if data.get("status") == "FAIL" or not all(checked.values()):
            return "FAIL", checked
    except (ValueError, TypeError, KeyError):
        pass
    return "BLOCKED", {}

def qa_prompt(flag):
    return (
        "MWHABIT DEV Chromium QA, issue #219. Browser READ-ONLY ONLY. "
        "Use Claude in Chrome browser tools on ONLY " + APP_URL + "/admin/centers. "
        "Do not access other sites, personal tabs, login credentials or production. "
        "Do not click approve/reject, perform reservations, pay, edit files, run shell, "
        "execute SQL, deploy, or merge PRs. Do not enter passwords. "
        "If site login is not already authenticated, if permission prompt occurs, "
        "or Chrome cannot connect, report BLOCKED. "
        "Test NEXT_PUBLIC_ADMIN_CENTER_PAGINATION=" + flag + ". "
        "In real Chrome verify platform administrator access, at most 30 items first "
        "page, three status tabs, search/clear maintaining tab, more button/last "
        "page boundary, duplicate centers absence, and console/network errors. "
        "If fewer than 31 DEV fixtures, pagination_boundary=false (incomplete). "
        "Actually CALL navigate, read_page, read_console_messages, "
        "read_network_requests. Do not infer PASS from source code. "
        "Reply ONLY JSON: status=PASS/FAIL/BLOCKED, checks mapping each to true "
        "or false, note short with NO user data. Required checks: " + json.dumps(CHECKS)
    )

def start_server(child_env):
    with socket.socket() as sock:
        if sock.connect_ex(("127.0.0.1", 3199)) == 0:
            raise Blocked("QA 전용 포트 3199 사용 중")
    return subprocess.Popen(
        ["npm", "run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3199"],
        cwd=ROOT, env=child_env, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True)

def wait_server(proc):
    for _ in range(90):
        if proc.poll() is not None:
            raise Blocked("DEV 서버 실행 실패")
        try:
            with urllib.request.urlopen(APP_URL + "/login", timeout=2) as response:
                if response.status < 400:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise Blocked("DEV 서버 기동 시간 초과")

def run_flag(flag, env):
    child_env = dict(os.environ)
    child_env.update(env)
    child_env["NEXT_PUBLIC_ADMIN_CENTER_PAGINATION"] = flag
    child_env["NODE_ENV"] = "development"
    proc = start_server(child_env)
    try:
        wait_server(proc)
        cmd = ["claude", "-p", "--chrome", "--setting-sources", "",
               "--tools", "ToolSearch,Skill,mcp__claude-in-chrome__*",
               "--permission-mode", "dontAsk", "--no-session-persistence",
               "--verbose", "--output-format", "stream-json",
               "--max-budget-usd", "1"]
        try:
            result = subprocess.run(cmd, input=qa_prompt(flag), capture_output=True,
                                    text=True, cwd=ROOT, env=child_env, timeout=1200)
        except subprocess.TimeoutExpired:
            raise Blocked("Claude Chrome 실행 시간 초과") from None
        if result.returncode:
            raise Blocked("Claude Chrome 실행 실패 (계정/브라우저 권한 확인)")
        response, names = parse_chrome_output(result.stdout)
        status, checks = judge(response, names)
        return {"status": status, "checks": checks,
                "chrome_tools": sorted(n for n in names if n.startswith("mcp__claude-in-chrome__"))}
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=8)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

def notify(config, state, event, sha):
    topic = config.get("NTFY_TOPIC", "")
    if not topic:
        return
    key = str(ISSUE) + ":" + sha + ":" + event
    if key in state["notifications"]:
        return
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,128}", topic):
        print("ntfy: topic 형식 오류 (값 비공개)")
        return
    token = config.get("NTFY_TOKEN", "")
    headers = {"Title": "MWHABIT QA"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request("https://ntfy.sh/" + topic,
        data=("MWHABIT #219 Chrome QA " + event + " " + sha[:7]).encode(),
        headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            if 200 <= r.status < 300:
                state["notifications"].append(key)
    except Exception as exc:
        print("ntfy 전송 실패: " + type(exc).__name__)

def issue_report(state):
    lines = ["### Claude Chrome DEV QA 결과",
             "- Issue: #219 / commit: " + state["commit"][:12],
             "- 상태: **" + state["status"] + "** (PASS_REPORTED는 자동 병합 승인 아님)",
             "- DEV: localhost:3199, flag ON/OFF 분리 확인"]
    for flag, data in state["results"].items():
        lines.append("- flag " + flag + ": " + data["status"] + "; Chrome tools: "
                     + ", ".join(data.get("chrome_tools", [])))
    lines.append("- 비밀값/원본 콘솔/스크린샷/trace 미게시. 운영/결제/SQL 변경 없음.")
    result = subprocess.run(["gh", "issue", "comment", str(ISSUE), "--repo", REPO,
                             "--body", "\n".join(lines)], capture_output=True, text=True, timeout=30)
    if result.returncode:
        print("GitHub 댓글 전송 실패: gh 인증/네트워크 확인 필요")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = STATE / "qa.lock"
    try:
        fd = os.open(lock, os.O_EXCL | os.O_CREAT | os.O_WRONLY, 0o600)
    except FileExistsError:
        print("BLOCKED: 다른 QA 워커 실행 중")
        return 2
    try:
        os.close(fd)
        if (STATE / "BROWSER_QA_DISABLED").exists():
            raise Blocked("QA kill switch 활성")
        config = read_env(STATE / "browser-qa.env")
        if not args.execute or config.get("MWHABIT_BROWSER_QA_ENABLED") != "1":
            print("DRY_RUN: 기본 비활성; 승인 후 --execute")
            return 0
        if config.get("MWHABIT_QA_CHROME_APPROVED") != "1":
            raise Blocked("Mac Chrome 권한 승인 필요")
        fixture = read_env(TEST_ENV)
        dev_ref = validate_target(fixture, config.get("QA_DEV_PROJECT_REF", ""))
        chrome_ready()
        if not issue_is_approved():
            raise Blocked("Issue #219 승인 라벨/작성자/상태 불일치")
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT,
                                      text=True, timeout=15).strip()
        path = STATE / "issue-219.json"
        prev = json.loads(path.read_text()) if path.is_file() else {}
        if not args.force and prev.get("commit") == sha and prev.get("terminal"):
            print("SKIPPED: 이미 기록된 SHA (재시도 --force)")
            return 0
        state = {"issue": ISSUE, "commit": sha, "dev_ref": dev_ref,
                 "started_at": datetime.now(timezone.utc).isoformat(),
                 "terminal": False, "notifications": prev.get("notifications", []),
                 "results": {}}
        notify(config, state, "STARTED", sha)
        for flag in ("true", "false"):
            try:
                data = run_flag(flag, fixture)
            except Blocked as exc:
                data = {"status": "BLOCKED", "reason": str(exc)}
            state["results"][flag] = data
            if data["status"] == "BLOCKED":
                break
        statuses = [x["status"] for x in state["results"].values()]
        state["status"] = ("PASS_REPORTED" if statuses == ["PASS_REPORTED", "PASS_REPORTED"]
                           else "FAIL" if "FAIL" in statuses else "BLOCKED")
        state["terminal"] = True
        notify(config, state, state["status"], sha)
        path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        path.chmod(0o600)
        issue_report(state)
        print(state["status"] + ": GitHub #219, SHA " + sha[:7])
        return 0 if state["status"] == "PASS_REPORTED" else 2
    except Blocked as exc:
        print("BLOCKED: " + str(exc))
        return 2
    except Exception as exc:
        print("BLOCKED: 예기치 않은 오류 " + type(exc).__name__)
        return 2
    finally:
        lock.unlink(missing_ok=True)

if __name__ == "__main__":
    sys.exit(main())
