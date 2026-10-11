#!/usr/bin/env python3
"""MWHABIT 자동 개발 에이전트 진입점. 읽기 전용 run_tasks.py와 완전히 분리되어 있다.

기본은 비활성이다(dev_agent.config.json의 enabled=false). 사용법은 README_DEV_AGENT.md 참고.
  python3 run_dev_tasks.py check-config   # 설정/권한 파일 검증(네트워크 없음)
  python3 run_dev_tasks.py status         # Issue별 상태
  python3 run_dev_tasks.py run            # 대기 Issue 1개 처리(enabled=true일 때만)
  python3 run_dev_tasks.py ack N|reset N  # 실패/차단 확인, 재실행 준비(worktree 삭제 안 함)
  python3 run_dev_tasks.py publish N      # publish_enabled=true일 때만 push+Draft PR
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dev_agent import claude_runner, orchestrator, publish as publish_mod
from dev_agent.config import ConfigError, load_config, KILL_SWITCH
from dev_agent.state import StateStore
from dev_agent.util import Shell


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd")
    for name in ("run", "scheduled", "status", "check-config"):
        sub.add_parser(name)
    for name in ("ack", "reset", "publish"):
        sub.add_parser(name).add_argument("number", type=int)
    args = parser.parse_args(argv)
    cmd = args.cmd or "run"
    try:
        cfg = load_config()
    except ConfigError as exc:
        print(f"설정 오류: {exc}", file=sys.stderr)
        return 2

    if cmd == "check-config":
        import os
        claude_runner.build_settings(cfg, os.environ.get("HOME", "/"))
        print(f"설정 OK — enabled={cfg.enabled}, publish_enabled={cfg.publish_enabled}, label={cfg.label}, owner={cfg.owner}")
        return 0
    store = StateStore(Path(cfg.state_dir))
    if cmd == "status":
        rows = store.all()
        print(f"작업 {len(rows)}개" if rows else "기록 없음")
        for d in rows:
            fail = d.get("failure")
            print(f"  #{d['issue']} {d['status']} (시도 {d.get('attempt')}, ack={d.get('acked')})" + (f" — {fail['stage']}: {fail['reason'][:120]}" if fail else ""))
        return 0
    if cmd == "ack":
        store.ack(args.number); print(f"#{args.number} 확인 처리(자동 재실행되지 않음)"); return 0
    if cmd == "reset":
        dest = store.archive(args.number)
        print(f"#{args.number} 상태를 {dest}로 보관했습니다. worktree/브랜치는 삭제하지 않았습니다(다음 시도는 새 이름 사용).")
        return 0
    if cmd == "publish":
        try:
            lock = orchestrator.acquire_lock()
            try:
                state = store.load(args.number)
                out = publish_mod.publish(cfg, Shell(), state, Path(state["pr_plan"]), Path(state["pr_body"]))
                store.update(args.number, "published", pr_url=out["pr_url"])
            finally:
                lock.close()
        except (publish_mod.PublishError, orchestrator.SkipRun) as exc:
            print(f"게시하지 않음: {exc}", file=sys.stderr); return 1
        print(out["pr_url"]); return 0

    result = orchestrator.run_once(cfg)
    if cmd == "scheduled" and cfg.enabled and cfg.publish_enabled and not KILL_SWITCH.exists():
        try:
            lock = orchestrator.acquire_lock()
            try:
                for state in store.all():
                    if state["status"] != "ready_for_pr":
                        continue
                    out = publish_mod.publish(cfg, Shell(), state, Path(state["pr_plan"]), Path(state["pr_body"]))
                    store.update(state["issue"], "published", pr_url=out["pr_url"])
                    result["published"] = out
                    break
            finally:
                lock.close()
        except (publish_mod.PublishError, orchestrator.SkipRun) as exc:
            result["publish_attention"] = str(exc)
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result.get("outcome") in ("failed", "blocked") else 0


if __name__ == "__main__":
    sys.exit(main())
