from __future__ import annotations

import json
import os
import re
import tempfile
import time
from pathlib import Path

RUNNING = {"preparing", "claude_running", "validating", "testing", "committing"}
TERMINAL_OK = {"ready_for_pr", "published"}
NEEDS_ATTENTION = {"failed", "blocked"}   # 자동 재시도 없음 — 사람이 ack/reset 해야 한다
ALL_STATUSES = RUNNING | TERMINAL_OK | NEEDS_ATTENTION


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


class StateStore:
    """Issue 번호마다 별도 상태 파일(issue-N.json). 원자적 쓰기, 권한 0600."""

    def __init__(self, directory: Path):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "archive").mkdir(exist_ok=True)

    def path(self, number: int) -> Path:
        if not isinstance(number, int) or number <= 0:
            raise ValueError("Issue 번호가 올바르지 않습니다.")
        return self.dir / f"issue-{number}.json"

    def exists(self, number: int) -> bool:
        return self.path(number).exists()

    def load(self, number: int) -> dict:
        return json.loads(self.path(number).read_text())

    def all(self) -> list[dict]:
        out = []
        for p in sorted(self.dir.glob("issue-*.json")):
            if not re.fullmatch(r"issue-[1-9][0-9]*\.json", p.name):
                continue
            try:
                out.append(json.loads(p.read_text()))
            except json.JSONDecodeError:
                out.append({"issue": int(p.stem.split("-")[1]), "status": "failed", "failure": {"stage": "state", "reason": "상태 파일 손상"}, "acked": False})
        return out

    def _write(self, number: int, data: dict) -> None:
        fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".json", dir=self.dir)
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path(number))
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def create(self, number: int, **fields) -> dict:
        if self.exists(number):
            raise FileExistsError(f"Issue #{number}에는 이미 실행 상태가 있습니다.")
        attempt = 1 + len(list((self.dir / "archive").glob(f"issue-{number}.*.json")))
        data = {"issue": number, "status": "preparing", "attempt": attempt, "created_at": now(),
                "updated_at": now(), "acked": False, "history": [{"ts": now(), "status": "preparing"}], **fields}
        self._write(number, data)
        return data

    def update(self, number: int, status: str | None = None, **fields) -> dict:
        data = self.load(number)
        if status is not None:
            if status not in ALL_STATUSES:
                raise ValueError(f"알 수 없는 상태: {status}")
            if data["status"] in TERMINAL_OK | NEEDS_ATTENTION and status in RUNNING:
                raise ValueError(f"종료된 작업({data['status']})을 다시 실행 상태로 되돌릴 수 없습니다.")
            data["status"] = status
            data["history"].append({"ts": now(), "status": status})
        data.update(fields)
        data["updated_at"] = now()
        self._write(number, data)
        return data

    def fail(self, number: int, stage: str, reason: str, blocked: bool = False) -> dict:
        return self.update(number, "blocked" if blocked else "failed",
                           failure={"stage": stage, "reason": reason[:2000]}, acked=False)

    def ack(self, number: int) -> dict:
        data = self.load(number)
        if data["status"] not in NEEDS_ATTENTION:
            raise ValueError("실패/차단 상태의 작업만 확인(ack)할 수 있습니다.")
        return self.update(number, acked=True)

    def archive(self, number: int) -> Path:
        """재실행을 위해 상태를 보관 폴더로 옮긴다. worktree/브랜치는 삭제하지 않는다."""
        data = self.load(number)
        if data["status"] in RUNNING:
            raise ValueError("실행 중인 작업은 reset 할 수 없습니다.")
        dest = self.dir / "archive" / f"issue-{number}.{data.get('attempt', 0)}.{int(time.time())}.json"
        os.replace(self.path(number), dest)
        return dest

    def recover_interrupted(self) -> list[int]:
        """잠금을 잡은 상태에서만 호출한다. 실행 중으로 남은 작업은 중단된 것이므로 failed 처리(자동 재개 없음)."""
        recovered = []
        for data in self.all():
            if data.get("status") in RUNNING:
                self.fail(data["issue"], "interrupted", f"이전 실행이 '{data['status']}' 단계에서 중단됨(자동 재개하지 않음)")
                recovered.append(data["issue"])
        return recovered

    def unacked_attention(self) -> list[dict]:
        return [d for d in self.all() if d.get("status") in NEEDS_ATTENTION and not d.get("acked")]
