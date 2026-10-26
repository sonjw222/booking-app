#!/usr/bin/env node
/*
  purge-ci-residue.mjs 가 저장한 복구 자료로 수업·예약·CASCADE 자식 행을 다시 넣는다(검토용, 실행된 적 없음). 기본 dry-run, --execute 로 쓰기.
  이미 있는 행은 건드리지 않는다(ignore-duplicates). 순서: classes → reservations → children. 대상은 백업 파일에 있던 행 그대로이며 새 id 를 만들지 않는다.
  사용: PURGE_ENV_FILE=<공유 DEV env 파일> node restore-ci-residue.mjs <backup.json> [--execute]
*/
import fs from "node:fs";
const [file, ...rest] = process.argv.slice(2); const EXECUTE = rest.includes("--execute");
const die = (m) => { console.error("ABORT: " + m); process.exit(2); };
if (!file || !process.env.PURGE_ENV_FILE) die("백업 파일과 PURGE_ENV_FILE 필요");
const b = JSON.parse(fs.readFileSync(file, "utf8")); if (!b.planSha256 || !Array.isArray(b.classes)) die("백업 형식이 아님");
const env = Object.fromEntries(fs.readFileSync(process.env.PURGE_ENV_FILE, "utf8").split("\n").filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url?.includes("jdglfvwdnkjnraqdxuuj") || url.includes("bxntqggkfwnhcczsbqtj")) die("대상이 공유 DEV 가 아님");
const H = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" };
const steps = [["classes", b.classes], ["reservations", b.reservations], ...Object.entries(b.children ?? {})];
for (const [t, rows] of steps) {
  console.log(`${t}: ${rows.length}건`); if (!EXECUTE || !rows.length) continue;
  const r = await fetch(`${url}/rest/v1/${t}`, { method: "POST", headers: H, body: JSON.stringify(rows) });
  if (!r.ok) die(`${t} 복원 실패(${r.status}) — 중단`);
}
console.log(EXECUTE ? "복원 완료" : "dry-run 완료(쓰기 없음)");
