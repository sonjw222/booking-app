from __future__ import annotations

import logging
import os
import re
import subprocess
import unicodedata
from pathlib import Path

# 로그/보고서에 남기기 전에 인증정보처럼 보이는 값을 가린다.
_TOKEN_PATTERNS = [
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}"),
]
_SECRET_ENV_HINT = re.compile(r"(?i)(key|token|secret|password|passwd|credential|auth)")
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")


def redact(text: str, environ: dict | None = None) -> str:
    environ = os.environ if environ is None else environ
    for name, value in environ.items():
        if value and len(value) >= 8 and _SECRET_ENV_HINT.search(name):
            text = text.replace(value, "[REDACTED_ENV]")
    for pat in _TOKEN_PATTERNS:
        text = pat.sub("[REDACTED]", text)
    return text


def clean_text(text: str, limit: int) -> str:
    """외부(Issue 등) 텍스트를 데이터로만 쓰기 위한 정리: ANSI/제어문자 제거, 길이 제한."""
    text = _ANSI.sub("", text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch for ch in text if ch in "\n\t" or unicodedata.category(ch)[0] != "C")
    if len(text) > limit:
        text = text[:limit] + "\n…(길이 제한으로 잘림)"
    return text


def minimal_env(extra: dict | None = None) -> dict:
    """하위 프로세스에 넘길 환경변수 화이트리스트. 토큰/키 등은 넘기지 않는다."""
    env = {}
    for key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "SHELL"):
        if key in os.environ:
            env[key] = os.environ[key]
    env.update(extra or {})
    return env


class Shell:
    """subprocess 래퍼. 테스트에서는 같은 인터페이스의 가짜 객체로 교체한다. 항상 shell=False."""

    def run(self, cmd, cwd=None, env=None, timeout=60, input=None):
        return subprocess.run(
            list(cmd), cwd=cwd, env=env if env is not None else minimal_env(),
            capture_output=True, text=True, timeout=timeout, input=input, check=False,
        )


def get_logger(logs_dir: Path) -> logging.Logger:
    logs_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("dev_agent")
    if not logger.handlers:
        handler = logging.FileHandler(logs_dir / "dev_agent.log", encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
        stream = logging.StreamHandler()
        stream.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(stream)
        logger.setLevel(logging.INFO)
    return logger


def log(logger: logging.Logger, level: int, message: str) -> None:
    logger.log(level, redact(message))
