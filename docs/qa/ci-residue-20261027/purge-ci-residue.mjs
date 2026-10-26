#!/usr/bin/env node
/*
  공유 DEV CI 잔여 수업 23건 정리 스크립트 — 검토용. 이 파일은 작성만 되었고 실행된 적이 없다.

  범위: cleanup-plan.json 에 적힌 23개 수업 ID(그 수업의 예약 12건)로만 동작한다. ID 를 인자로 받지 않으며, 계획 파일의 SHA-256 이
  아래 상수와 다르면 중단한다(계획이 바뀌면 사람이 다시 검토 후 상수를 갱신).
  기본은 dry-run(읽기만). 실제 삭제는 --execute + PURGE_ACK=<계획 SHA 앞 12자리> 둘 다 필요.

  실행 전 대조(하나라도 불일치·조회 실패·소유권 불명이면 어떤 쓰기도 하지 않고 종료): 대상 호스트가 공유 DEV 인지 / 각 수업의 센터·제목·생성 시각이 계획과 같은지 /
  예약 id 집합이 계획과 정확히 같은지 / 예약 프로필이 테스트 계정 허용 목록뿐인지 / admin_action_logs 참조 0 / 그 밖의 참조 건수가 계획과 같은지.
  복구 자료: 삭제 직전에 대상 행 전체(수업·예약·CASCADE 자식)를 JSON 으로 --backup-dir 에 0600 으로 저장한다. restore-ci-residue.mjs 로 되돌릴 수 있다.

  원자성/부분 삭제: PostgREST 요청 하나는 하나의 트랜잭션이지만 "예약 삭제 → 수업 삭제" 두 요청은 하나로 묶을 수 없다(새 RPC/SQL 은 공유 DEV 변경이라 만들지 않음).
  따라서 예약 삭제 성공 후 수업 삭제가 실패하면 "수업만 남은" 상태가 된다(안전한 중간 상태). 이때는 --allow-reservations-already-deleted 로 다시 실행하면 수업만 삭제한다.
  각 DELETE 는 Prefer: return=representation 으로 실제 삭제된 id 를 받아 계획과 다르면 즉시 중단하고 상태를 출력한다. 자동 재시도는 하지 않는다.

  사전 확인(사람): 실행 중인 live CI 가 없어야 한다(concurrency 그룹 shared-live-supabase-tests) — 실행과 겹치면 안 된다.
  환경: PURGE_ENV_FILE=<공유 DEV 의 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 든 파일>. 키는 출력하지 않는다.
*/
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { fileURLToPath } from "node:url";

const PLAN_SHA256 = "eac60b4a9dbfa30fed7e4384e31800c0547927b4032e3faf7459188565f3fe8d";
const SHARED_DEV_REF = "jdglfvwdnkjnraqdxuuj", PRODUCTION_REF = "bxntqggkfwnhcczsbqtj";
const ALLOWED_PROFILE_KINDS = new Set(["CI User A", "CI User B", "E2E 대기인원 임시", "탈퇴한 회원"]);
const args = process.argv.slice(2); const flag = (n) => args.includes(n); const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const EXECUTE = flag("--execute"), RES_GONE_OK = flag("--allow-reservations-already-deleted");
const die = (m, code = 2) => { console.error("ABORT: " + m); process.exit(code); };

const dir = path.dirname(fileURLToPath(import.meta.url));
const planRaw = fs.readFileSync(path.join(dir, "cleanup-plan.json"));
if (crypto.createHash("sha256").update(planRaw).digest("hex") !== PLAN_SHA256) die("cleanup-plan.json 이 검토된 버전과 다름(SHA-256 불일치) — 새로 검토 필요");
const planDoc = JSON.parse(planRaw.toString("utf8")); const plan = planDoc.plan;
if (!planDoc.allEligible || plan.length !== 23 || plan.some((p) => p.exists === false || !p.eligibleForDeletion)) die("계획이 '전체 삭제 가능'이 아님");
const IDS = plan.map((p) => p.classId); if (new Set(IDS).size !== 23) die("계획의 수업 id 중복");
const RES_IDS = plan.flatMap((p) => p.reservationIds);
if (EXECUTE && process.env.PURGE_ACK !== PLAN_SHA256.slice(0, 12)) die("--execute 에는 PURGE_ACK=<계획 SHA-256 앞 12자리> 가 필요");
if (EXECUTE && !opt("--backup-dir")) die("--execute 에는 --backup-dir 가 필요(복구 자료 저장 위치, 저장소 밖 권장)");

const envFile = process.env.PURGE_ENV_FILE; if (!envFile) die("PURGE_ENV_FILE 필요");
const env = Object.fromEntries(fs.readFileSync(envFile, "utf8").split("\n").filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) die("URL/키 없음");
if (url.includes(PRODUCTION_REF)) die("Production 대상 — 거부");
if (!url.includes(SHARED_DEV_REF)) die("대상이 공유 DEV(mwhabit-ci-dev)가 아님");
const H = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
const inList = (a) => `in.(${a.join(",")})`;
async function get(p) { const r = await fetch(`${url}/rest/v1/${p}`, { headers: H }); if (!r.ok) die(`조회 실패 ${p.split("?")[0]} (${r.status}) — 조회 실패는 삭제 근거가 아님`); return r.json(); }

// ---- 1) 사전 대조(읽기 전용) ----
const live = await get(`classes?id=${inList(IDS)}&select=*`);
const liveBy = new Map(live.map((r) => [r.id, r]));
const profileIdsAll = new Set(); const liveRes = await get(`reservations?class_id=${inList(IDS)}&select=*`);
for (const r of liveRes) profileIdsAll.add(r.profile_id);
const profs = profileIdsAll.size ? await get(`profiles?id=${inList([...profileIdsAll])}&select=id,name`) : [];
const kind = new Map(profs.map((p) => [p.id, p.name]));
const mism = [];
for (const p of plan) {
  const c = liveBy.get(p.classId);
  if (!c) { if (!RES_GONE_OK) mism.push(`${p.classId}: 수업이 이미 없음(계획과 다름)`); continue; }
  if (c.center_id !== p.centerId || c.title !== p.title || c.created_at !== p.createdAt) mism.push(`${p.classId}: 센터/제목/생성 시각이 계획과 다름`);
  const lr = liveRes.filter((r) => r.class_id === p.classId).map((r) => r.id).sort();
  const pr = [...p.reservationIds].sort();
  const same = JSON.stringify(lr) === JSON.stringify(pr);
  if (!same && !(RES_GONE_OK && lr.length === 0)) mism.push(`${p.classId}: 예약 id 집합이 계획과 다름(계획 ${pr.length}건, 현재 ${lr.length}건)`);
  for (const r of liveRes.filter((x) => x.class_id === p.classId)) if (!ALLOWED_PROFILE_KINDS.has(kind.get(r.profile_id) ?? "")) mism.push(`${p.classId}: 허용 목록 밖 프로필의 예약 ${r.id}`);
}
const cols = planDoc.referencingColumns;
for (const [t, c] of cols.classes) {
  const rows = await get(`${t}?${c}=${inList(IDS)}&select=${c}&limit=5000`);
  if (t === "admin_action_logs" && rows.length) mism.push(`admin_action_logs.${c} 참조 ${rows.length}건 — 감사 기록이라 삭제 금지`);
  if (t !== "admin_action_logs" && t !== "reservations") { const exp = plan.reduce((s, p) => s + (typeof p.referenceCounts[`${t}.${c}`] === "number" ? p.referenceCounts[`${t}.${c}`] : 0), 0); if (rows.length !== exp) mism.push(`${t}.${c}: 계획 ${exp}건, 현재 ${rows.length}건`); }
}
if (liveRes.length) for (const [t, c] of cols.reservations) {
  const rows = await get(`${t}?${c}=${inList(liveRes.map((r) => r.id))}&select=${c}&limit=5000`);
  if (rows.length) mism.push(`${t}.${c}: 예약 참조 ${rows.length}건(계획은 0) — 중단`);
}
console.log(`대상 ${IDS.length}개 수업 · 예약 ${liveRes.length}/${RES_IDS.length}건 · 대조 불일치 ${mism.length}건 · 모드 ${EXECUTE ? "EXECUTE" : "dry-run"}`);
if (mism.length) { mism.forEach((m) => console.error("  - " + m)); die("사전 대조 불일치 — 아무것도 쓰지 않고 종료"); }
if (!EXECUTE) { console.log("dry-run 완료(쓰기 없음). 실제 삭제는 --execute --backup-dir <dir> 와 PURGE_ACK 필요."); process.exit(0); }

// ---- 2) 복구 자료 ----
const bdir = path.resolve(opt("--backup-dir")); fs.mkdirSync(bdir, { recursive: true });
const children = {};
for (const [t, c] of cols.classes) if (!["admin_action_logs", "reservations"].includes(t)) children[t] = await get(`${t}?${c}=${inList(IDS)}&select=*`);
const backup = { createdAt: new Date().toISOString(), planSha256: PLAN_SHA256, classes: live, reservations: liveRes, children };
const bfile = path.join(bdir, `ci-residue-backup-${Date.now()}.json`); fs.writeFileSync(bfile, JSON.stringify(backup), { mode: 0o600 });
console.log("복구 자료 저장:", bfile, `(수업 ${live.length}, 예약 ${liveRes.length})`);

// ---- 3) 삭제: 예약 → 수업 (두 요청, 각각 원자적. 두 요청 사이는 비원자적) ----
async function del(p, expectIds, label) {
  const r = await fetch(`${url}/rest/v1/${p}`, { method: "DELETE", headers: { ...H, Prefer: "return=representation" } });
  if (!r.ok) die(`${label} 삭제 실패(${r.status}) — 이후 단계 중단. 현재 상태를 조회해 확인하세요`, 3);
  const got = (await r.json()).map((x) => x.id).sort(); const exp = [...expectIds].sort();
  if (JSON.stringify(got) !== JSON.stringify(exp)) die(`${label}: 삭제된 id 가 계획과 다름(삭제 ${got.length}건/계획 ${exp.length}건) — 즉시 중단, 백업으로 대조하세요`, 4);
  console.log(`${label}: ${got.length}건 삭제`);
}
const centerId = plan[0].centerId; if (plan.some((p) => p.centerId !== centerId)) die("센터가 여러 개 — 계획 재검토 필요");
const minC = plan.map((p) => p.createdAt).sort()[0], maxC = plan.map((p) => p.createdAt).sort().at(-1);
if (liveRes.length) await del(`reservations?id=${inList(liveRes.map((r) => r.id))}&class_id=${inList(IDS)}`, liveRes.map((r) => r.id), "예약");
await del(`classes?id=${inList(live.map((c) => c.id))}&center_id=eq.${centerId}&created_at=gte.${encodeURIComponent(minC)}&created_at=lte.${encodeURIComponent(maxC)}`, live.map((c) => c.id), "수업");

// ---- 4) 사후 확인 ----
const left = await get(`classes?id=${inList(IDS)}&select=id`); const leftRes = await get(`reservations?class_id=${inList(IDS)}&select=id`);
console.log(`사후 확인: 남은 수업 ${left.length}, 남은 예약 ${leftRes.length}`); process.exit(left.length || leftRes.length ? 5 : 0);
