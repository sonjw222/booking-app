from __future__ import annotations

import fnmatch
import os
import re
from pathlib import Path

from .config import Config

# 허용 접두사 안이라도 절대 안 되는 경로(HIGH 위험: DB/인증정보/네이티브/CI/의존성)
DENY_GLOBS = [
    "*.sql", "**/*.sql", ".env", ".env.*", "**/.env", "**/.env.*", ".github/*", ".github/**", "supabase/**", "ios/**", "android/**",
    "package.json", "package-lock.json", "**/package.json", "**/package-lock.json", "capacitor.config.*", "next.config.*",
    "scripts/**", "public/sw.js", "app/.well-known/**", "**/*.pem", "**/*.key", "**/*.p12", "**/*.p8", "**/*.keystore",
    "**/GoogleService-Info.plist", "**/google-services.json", "**/*.mobileprovision", "**/.git/**", ".git/**",
    "tests/e2e/fixtures/env.ts", "tests/integration/loadEnv.ts", "tests/integration/productionGuard.ts",
]
SECRET_PATTERNS = [
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}")),
    ("github-token", re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}")),
    ("api-key", re.compile(r"sk-[A-Za-z0-9_-]{20,}")),
    ("service-role", re.compile(r"SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['\"]?[A-Za-z0-9._-]{16,}")),
    ("assigned-secret", re.compile(r"(?i)(secret|password|token)\s*[:=]\s*['\"][A-Za-z0-9+/=_-]{16,}['\"]")),
]
DANGEROUS_CODE = [
    ("child_process", re.compile(r"child_process|execSync|spawnSync")),
    ("drop-sql", re.compile(r"(?i)\bdrop\s+table\b|\btruncate\s+table\b")),
]


class GuardResult(dict):
    pass


def _match(path: str, glob: str) -> bool:
    return fnmatch.fnmatchcase(path, glob) or fnmatch.fnmatchcase(path, glob.replace("**/", ""))


def list_changes(cfg: Config, shell, worktree: str) -> list[dict]:
    """worktree의 모든 변경(수정/추가/삭제/미추적)을 NUL 구분 porcelain 으로 읽는다."""
    r = shell.run([cfg.git_bin, "-C", worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"], timeout=60)
    if r.returncode != 0:
        raise RuntimeError("git status 실패")
    entries = [e for e in r.stdout.split("\0") if e]
    changes, i = [], 0
    while i < len(entries):
        code, path = entries[i][:2], entries[i][3:]
        if code[0] in "RC":   # 이름 변경/복사는 다음 항목이 원본 경로 — 둘 다 검사
            changes.append({"code": code, "path": entries[i + 1]})
            i += 1
        changes.append({"code": code, "path": path})
        i += 1
    return changes


def validate(cfg: Config, shell, worktree: str, base_sha: str, branch: str) -> GuardResult:
    """Claude 실행 후 변경이 허용 범위인지 검사한다. problems가 비어 있어야 다음 단계로 간다."""
    problems: list[str] = []
    wt = Path(worktree).resolve()
    head = shell.run([cfg.git_bin, "-C", worktree, "rev-parse", "HEAD"], timeout=30).stdout.strip()
    if head != base_sha:
        problems.append("HEAD가 기준 커밋과 다름(커밋/리셋이 일어남)")
    cur = shell.run([cfg.git_bin, "-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], timeout=30).stdout.strip()
    if cur != branch:
        problems.append(f"브랜치가 바뀜: {cur}")
    changes = list_changes(cfg, shell, worktree)
    files = sorted({c["path"] for c in changes})
    if not files:
        problems.append("변경된 파일이 없음")
    if len(files) > cfg.max_files:
        problems.append(f"변경 파일이 너무 많음({len(files)} > {cfg.max_files})")
    total_lines = 0
    secret_hits: list[str] = []
    for c in changes:
        rel, deleted = c["path"], "D" in c["code"]
        if rel.startswith("/") or ".." in Path(rel).parts or "\\" in rel:
            problems.append(f"위험한 경로: {rel}")
            continue
        if not rel.startswith(cfg.allowed_prefixes):
            problems.append(f"허용 범위 밖 경로: {rel}")
        for g in DENY_GLOBS:
            if _match(rel, g):
                problems.append(f"금지 경로 패턴({g}): {rel}")
                break
        if c["code"].strip() == "D" or deleted:
            continue
        full = wt / rel
        try:
            if full.is_symlink():
                problems.append(f"심볼릭 링크 금지: {rel}")
                continue
            if not full.is_file():
                continue
            if full.resolve().parent != full.parent.resolve() and wt not in full.resolve().parents:
                problems.append(f"worktree 밖을 가리킴: {rel}")
                continue
            data = full.read_bytes()
        except OSError:
            problems.append(f"읽을 수 없음: {rel}")
            continue
        if len(data) > cfg.max_file_bytes:
            problems.append(f"파일이 너무 큼({len(data)}B): {rel}")
        if b"\0" in data:
            problems.append(f"바이너리 파일 금지: {rel}")
            continue
        if os.stat(full).st_mode & 0o111 and not rel.endswith((".sh",)):
            problems.append(f"실행 권한이 있는 파일: {rel}")
        text = data.decode("utf-8", errors="replace")
        total_lines += text.count("\n") + 1
        for name, pat in SECRET_PATTERNS:
            if pat.search(text):
                secret_hits.append(f"{name}:{rel}")
        for name, pat in DANGEROUS_CODE:
            if pat.search(text) and rel.startswith(("app/", "lib/")):
                problems.append(f"위험한 코드 패턴({name}): {rel}")
    if secret_hits:
        problems.append("비밀 값으로 보이는 문자열: " + ", ".join(secret_hits))
    diff = shell.run([cfg.git_bin, "-C", worktree, "diff", "--numstat"], timeout=60).stdout
    changed = 0
    for line in diff.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and parts[0].isdigit() and parts[1].isdigit():
            changed += int(parts[0]) + int(parts[1])
    changed = max(changed, total_lines)
    if changed > cfg.max_changed_lines:
        problems.append(f"변경 줄 수가 너무 많음({changed} > {cfg.max_changed_lines})")
    return GuardResult(ok=not problems, problems=problems, files=files, changed_lines=changed)


def snapshot_source(cfg: Config, shell) -> dict:
    """원본 저장소 상태 스냅샷(실행 전/후 비교). 변경이 감지되면 사람이 확인하도록 차단한다."""
    host = cfg.git_host_path
    head = shell.run([cfg.git_bin, "-C", host, "rev-parse", "HEAD"], timeout=30).stdout.strip()
    status = shell.run([cfg.git_bin, "-C", host, "status", "--porcelain=v1"], timeout=60).stdout
    # 각 변경 파일의 mtime/크기까지 포함해 같은 파일이 다시 수정된 경우도 잡는다
    sig = []
    for line in status.splitlines():
        p = Path(host) / line[3:].split(" -> ")[-1]
        try:
            st = p.stat()
            sig.append(f"{line}|{st.st_size}|{int(st.st_mtime)}")
        except OSError:
            sig.append(line)
    return {"head": head, "status": sorted(sig)}
