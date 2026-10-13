from __future__ import annotations

import json
import re
from pathlib import Path

from .config import Config, KILL_SWITCH
from .issues import is_eligible, sha256
from .util import clean_text, redact

AUTHOR = ["-c", "user.name=MWHABIT Dev Agent", "-c", "user.email=mwhabit-dev-agent@users.noreply.github.com",
          "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"]   # 저장소 훅은 실행하지 않는다


class PublishError(Exception):
    pass


def commit_changes(cfg: Config, shell, worktree: str, files: list[str], issue: dict, base_sha: str) -> str:
    """검증을 통과한 파일만 명시적으로 스테이징해 로컬 커밋한다(push 아님)."""
    r = shell.run([cfg.git_bin, "-C", worktree, "add", "--", *files], timeout=60)
    if r.returncode != 0:
        raise PublishError("git add 실패")
    title = clean_text(issue.get("title") or "", 120).replace("\n", " ")
    msg = f"{title}\n\nIssue #{issue['number']} 자동 개발 초안 (Draft PR용, 사람 검토 필요).\nRefs #{issue['number']}"
    r = shell.run([cfg.git_bin, "-C", worktree, *AUTHOR, "commit", "-m", msg], timeout=60)
    if r.returncode != 0:
        raise PublishError(f"git commit 실패: {redact(r.stderr)[:200]}")
    sha = shell.run([cfg.git_bin, "-C", worktree, "rev-parse", "HEAD"], timeout=30).stdout.strip()
    committed = shell.run([cfg.git_bin, "-C", worktree, "diff", "--name-only", f"{base_sha}..{sha}"], timeout=30).stdout.split()
    if sorted(committed) != sorted(files):
        raise PublishError("커밋 파일이 검증된 목록과 다릅니다.")
    if shell.run([cfg.git_bin, "-C", worktree, "status", "--porcelain"], timeout=30).stdout.strip():
        raise PublishError("커밋 후 작업 트리가 깨끗하지 않습니다.")
    return sha


def build_pr_plan(cfg: Config, issue: dict, state: dict, commit_sha: str, files: list[str], checks: dict, summary: str) -> dict:
    title = "[AI draft] " + clean_text(issue.get("title") or "", 100).replace("\n", " ") + f" (#{issue['number']})"
    lines = [f"Refs #{issue['number']}  (자동 닫기 키워드는 사용하지 않음)", "", "## 변경 파일", *[f"- `{f}`" for f in files], "",
             "## 로컬 검증"]
    lines += [f"- {'✅' if c['ok'] else '❌'} {c['name']} — {c['detail'] or 'OK'}" for c in checks.get("results", [])]
    lines += ["", "## 최종 결과",
              f"검증된 변경 파일 {len(files)}개를 커밋 `{commit_sha}`에 저장했습니다.",
              "테스트 결과는 위 로컬 검증 항목이 최종 기록입니다. Claude 실행 중 보고는 상태/로그에 보관합니다.", "",
              "> 이 PR은 자동 개발 에이전트가 만든 **Draft**입니다. 사람이 검토하기 전에는 병합하지 마세요.",
              "> 인증·결제·예약·DB·네이티브 변경은 포함하지 않도록 자동 검사했습니다."]
    return {"issue": issue["number"], "repo": cfg.repo, "base": cfg.base_branch, "head": state["branch"], "draft": True,
            "title": title, "commit": commit_sha, "files": files, "body": "\n".join(lines)}


def write_plan(state_dir: Path, plan: dict) -> tuple[Path, Path]:
    n = plan["issue"]
    body_path = Path(state_dir) / f"issue-{n}.pr_body.md"
    plan_path = Path(state_dir) / f"issue-{n}.pr_plan.json"
    body_path.write_text(plan["body"] + "\n")
    with plan_path.open("w") as handle:
        json.dump({k: v for k, v in plan.items() if k != "body"}, handle, ensure_ascii=False, indent=2)
    return plan_path, body_path


def publish(cfg: Config, shell, state: dict, plan_path: Path, body_path: Path) -> dict:
    """원격 push + Draft PR 생성. publish_enabled가 꺼져 있으면 실행하지 않는다. main/강제 push/자동 병합 불가."""
    if Path(KILL_SWITCH).exists():
        raise PublishError("kill switch가 있어 게시하지 않습니다.")
    if not (cfg.enabled and cfg.publish_enabled):
        raise PublishError("publish_enabled가 꺼져 있어 push/PR을 만들지 않습니다.")
    plan = json.loads(Path(plan_path).read_text())
    branch = plan["head"]
    if plan["base"] != "main" or not branch.startswith(cfg.branch_prefix) or branch in ("main", "master"):
        raise PublishError("허용되지 않은 브랜치입니다.")
    if state.get("status") not in ("ready_for_pr", "published"):
        raise PublishError("ready_for_pr 상태에서만 게시할 수 있습니다.")
    url = shell.run([cfg.git_bin, "-C", state["worktree"], "remote", "get-url", cfg.remote], timeout=30).stdout.strip()
    if not re.search(rf"[:/]{re.escape(cfg.repo)}(\.git)?$", url):
        raise PublishError("원격 저장소가 설정된 저장소와 다릅니다.")
    head = shell.run([cfg.git_bin, "-C", state["worktree"], "rev-parse", "HEAD"], timeout=30).stdout.strip()
    if head != plan["commit"]:
        raise PublishError("worktree HEAD가 계획된 커밋과 다릅니다.")
    if plan.get("repo") != cfg.repo or plan.get("draft") is not True or branch != state.get("branch") or head != state.get("commit"):
        raise PublishError("게시 계획과 검증된 상태가 다릅니다.")
    existing = shell.run([cfg.gh_bin, "pr", "list", "--repo", cfg.repo, "--state", "all", "--head", branch,
                          "--json", "url,state,isDraft,headRefOid,baseRefName"], timeout=60)
    if existing.returncode != 0:
        raise PublishError("기존 PR 조회 실패")
    rows = json.loads(existing.stdout)
    if rows:
        if len(rows) != 1 or rows[0].get("state") != "OPEN" or rows[0].get("isDraft") is not True or rows[0].get("headRefOid") != head or rows[0].get("baseRefName") != plan["base"]:
            raise PublishError("기존 PR이 게시 계획과 다릅니다. 수동 검토가 필요합니다.")
        return {"pr_url": rows[0]["url"]}
    if state.get("status") == "published":
        raise PublishError("게시된 PR을 찾을 수 없습니다. 자동 재생성하지 않습니다.")
    live = shell.run([cfg.gh_bin, "issue", "view", str(plan["issue"]), "--repo", cfg.repo,
                      "--json", "number,title,body,state,author,labels"], timeout=60)
    if live.returncode != 0:
        raise PublishError("게시 직전 Issue 조회 실패")
    issue = json.loads(live.stdout)
    if not is_eligible(issue, cfg) or issue["number"] != state["issue"]:
        raise PublishError("게시 직전 Issue 승인/작성자 검증 실패")
    for field in ("title", "body"):
        expected = state.get(field + "_sha256")
        if expected and sha256(issue.get(field) or "") != expected:
            raise PublishError("실행 이후 Issue 내용이 변경됐습니다. 수동 검토가 필요합니다.")
    push = shell.run([cfg.git_bin, "-C", state["worktree"], "push", cfg.remote, f"HEAD:refs/heads/{branch}"], timeout=120)  # --force 없음
    if push.returncode != 0:
        raise PublishError("git push 실패(강제 push는 하지 않음)")
    pr = shell.run([cfg.gh_bin, "pr", "create", "--repo", cfg.repo, "--draft", "--base", "main", "--head", branch,
                    "--title", plan["title"], "--body-file", str(body_path)], timeout=60)
    if pr.returncode != 0:
        raise PublishError("gh pr create 실패")
    return {"pr_url": pr.stdout.strip().splitlines()[-1] if pr.stdout.strip() else ""}
