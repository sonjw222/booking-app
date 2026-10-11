from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .config import Config


class WorktreeError(Exception):
    pass


def _git(cfg: Config, shell, args, cwd=None, timeout=120):
    return shell.run([cfg.git_bin, *args], cwd=cwd, timeout=timeout)


def worktree_names(cfg: Config, number: int, attempt: int) -> tuple[Path, str]:
    if not isinstance(number, int) or number <= 0 or not isinstance(attempt, int) or attempt <= 0:
        raise WorktreeError("번호/시도 횟수가 올바르지 않습니다.")
    root = Path(cfg.worktrees_dir).resolve()
    path = (root / f"issue-{number}-a{attempt}").resolve()
    if path.parent != root:
        raise WorktreeError("worktree 경로가 허용 폴더를 벗어납니다.")
    branch = f"{cfg.branch_prefix}{number}-a{attempt}"
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", branch) or ".." in branch:
        raise WorktreeError("브랜치 이름이 올바르지 않습니다.")
    return path, branch


def file_sha256(path: Path) -> str | None:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def create_worktree(cfg: Config, shell, number: int, attempt: int) -> dict:
    """최신 origin/main에서 독립 worktree를 만든다. 기존 폴더/브랜치는 절대 재사용·덮어쓰기하지 않는다."""
    path, branch = worktree_names(cfg, number, attempt)
    host = cfg.git_host_path
    if path.exists():
        raise WorktreeError(f"이미 존재하는 경로입니다(덮어쓰지 않음): {path}")
    r = _git(cfg, shell, ["-C", host, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"])
    if r.returncode == 0:
        raise WorktreeError(f"이미 존재하는 브랜치입니다(재사용하지 않음): {branch}")
    # refs만 갱신한다(원본 작업 트리 파일은 건드리지 않음)
    r = _git(cfg, shell, ["-C", host, "fetch", cfg.remote, cfg.base_branch], timeout=180)
    if r.returncode != 0:
        raise WorktreeError("git fetch 실패")
    r = _git(cfg, shell, ["-C", host, "rev-parse", f"refs/remotes/{cfg.remote}/{cfg.base_branch}"])
    if r.returncode != 0:
        raise WorktreeError("원격 기준 브랜치를 찾지 못함")
    base_sha = r.stdout.strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    r = _git(cfg, shell, ["-C", host, "worktree", "add", "-b", branch, str(path), base_sha])
    if r.returncode != 0:
        raise WorktreeError(f"git worktree add 실패: {r.stderr.strip()[:300]}")
    head = _git(cfg, shell, ["-C", str(path), "rev-parse", "HEAD"]).stdout.strip()
    status = _git(cfg, shell, ["-C", str(path), "status", "--porcelain"]).stdout.strip()
    if head != base_sha or status:
        raise WorktreeError("새 worktree가 깨끗한 기준 상태가 아닙니다.")
    return {"path": str(path), "branch": branch, "base_sha": base_sha}


def link_node_modules(cfg: Config, shell, worktree: str) -> str:
    """원본의 node_modules를 복제(APFS clone)한다. package-lock이 다르면 설치하지 않고 중단한다."""
    src = Path(cfg.node_modules_source)
    if not src.is_dir():
        return "skipped:no-source"
    src_lock = file_sha256(src.parent / "package-lock.json")
    wt_lock = file_sha256(Path(worktree) / "package-lock.json")
    if src_lock is None or wt_lock is None or src_lock != wt_lock:
        raise WorktreeError("package-lock.json이 원본과 달라 node_modules를 재사용할 수 없습니다(설치는 하지 않음).")
    dest = Path(worktree) / "node_modules"
    if dest.exists():
        return "exists"
    r = shell.run(["cp", "-Rc", str(src), str(dest)], timeout=600)
    if r.returncode != 0:
        r = shell.run(["cp", "-R", str(src), str(dest)], timeout=900)
    if r.returncode != 0:
        raise WorktreeError("node_modules 복제 실패")
    return "cloned"
