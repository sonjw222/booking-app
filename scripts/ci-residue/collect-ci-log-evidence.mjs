// 읽기 전용(GitHub API GET 만): CI job 로그에서 id 별 등장 기록과 job 실행 구간을 수집한다(비밀·계정 정보 없음).
// 사용: node collect-ci-log-evidence.mjs <ids.txt> <out.json> [branch]
import { execFileSync } from "node:child_process"; import fs from "node:fs";
const gh = (a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 1 << 28 });
const ids = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
const runs = JSON.parse(gh(["run", "list", "--branch", (process.argv[4] ?? "test/qa-cleanup-safety-20261026"), "--limit", "10", "--json", "databaseId,headSha,createdAt,conclusion"]));
const ev = Object.fromEntries(ids.map((i) => [i, []]));
for (const r of runs) {
  const jobs = JSON.parse(gh(["run", "view", String(r.databaseId), "--json", "jobs"])).jobs.filter((j) => j.name.startsWith("E2E"));
  for (const j of jobs) {
    let log = ""; try { log = gh(["api", `repos/sonjw222/booking-app/actions/jobs/${j.databaseId}/logs`]); } catch { continue; }
    for (const line of log.split("\n")) for (const id of ids) if (line.includes(id)) {
      const ts = line.slice(0, 28); const kind = /\[E2E cleanup\]/.test(line) ? "cleanup-blocked" : /\[E2E teardown\]/.test(line) ? "teardown-unresolved" : /BLOCKED/.test(line) ? "create-blocked-by-residue" : "mention";
      ev[id].push({ run: r.databaseId, sha: r.headSha.slice(0, 7), job: j.name.slice(0, 8), jobId: j.databaseId, jobStart: j.startedAt, jobEnd: j.completedAt, logTime: ts.trim(), kind });
    }
  }
}
fs.writeFileSync(process.argv[3], JSON.stringify(ev, null, 1));
console.log(Object.entries(ev).map(([i, e]) => `${i.slice(0, 8)} ${e.length}`).join(" | "));
