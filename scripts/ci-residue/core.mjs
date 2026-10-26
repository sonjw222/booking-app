/*
  공유 DEV CI 잔여 수업 정리/복원 공용 코어(검토용). CLI(purge.mjs / restore.mjs / generate-plan.mjs)와 격리 DB 회귀 테스트가 같은 코드를 쓴다.
  이 모듈은 어떤 대상에도 스스로 접속하지 않는다 — 호출자가 client 를 만들어 넘기고, CLI 는 assertTarget 으로 정확한 HTTPS 호스트를 먼저 검증한다.
  원칙: 삭제 근거는 "소유 증명"이 아니라 "정황 근거가 있는 일회성 정리 승인 후보(approvalCandidate)"이며 승인은 사람이 한다. 비교는 건수가 아니라 고유번호·행 전체 해시·연결 관계·중요 상태로 한다.
*/
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
export const stable = (v) => JSON.stringify(sortKeys(v));
export const rowSha = (row) => sha256(stable(row));

/** 정확한 HTTPS 호스트 검증 — 문자열 포함 여부가 아니다. https · 호스트 == `<ref>.supabase.co` · 포트/계정정보/경로/쿼리 없음. */
export function assertTarget(raw, { allowedRef, forbiddenRefs = [] }) {
  let u; try { u = new URL(String(raw ?? "").trim()); } catch { throw new Error("대상 URL 을 해석할 수 없음"); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:") throw new Error(`HTTPS 가 아님(${u.protocol})`);
  if (u.port || u.username || u.password) throw new Error("포트/계정정보가 포함된 URL 은 거부");
  if (!(u.pathname === "/" || u.pathname === "") || u.search || u.hash) throw new Error("경로/쿼리/해시가 포함된 URL 은 거부");
  for (const f of forbiddenRefs) if (host === `${f}.supabase.co`) throw new Error("금지된 프로젝트(Production 등)");
  if (host !== `${allowedRef}.supabase.co`) throw new Error(`대상 호스트가 허용된 프로젝트(${allowedRef}.supabase.co)와 정확히 같지 않음`);
  return { host, origin: `https://${host}` };
}

/** 최소 PostgREST 클라이언트. restPrefix 는 공유 DEV 는 "/rest/v1", 격리 PostgREST(tests/rls-real)는 "". */
export function makeClient({ baseUrl, key, restPrefix = "/rest/v1", fetchImpl = fetch }) {
  const H = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const u = (p) => `${baseUrl}${restPrefix}/${p}`;
  const fail = async (what, r) => { throw new Error(`${what} 실패 (${r.status})`); };
  return {
    async get(p) { const r = await fetchImpl(u(p), { headers: H }); if (!r.ok) await fail(`조회 ${p.split("?")[0]}`, r); return r.json(); },
    async del(p) { const r = await fetchImpl(u(p), { method: "DELETE", headers: { ...H, Prefer: "return=representation" } }); if (!r.ok) await fail(`삭제 ${p.split("?")[0]}`, r); return r.json(); },
    async post(table, rows) { const r = await fetchImpl(u(table), { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(rows) }); if (!r.ok) await fail(`삽입 ${table}`, r); return r.json(); },
  };
}
const inList = (a) => `in.(${a.join(",")})`;
const byId = (rows) => new Map(rows.map((r) => [r.id, r]));

/** 계획에서 삭제/복원 대상이 될 수 있는 테이블(허용 목록). 이 밖의 테이블은 읽기/쓰기 모두 거부. */
export const CHILD_TABLES = ["class_allowed_products", "class_trainers", "schedule_memos"];
export const RES_CHILD_TABLES = ["reservation_goods_usages"];
export const WRITE_TABLES = ["classes", "reservations", ...CHILD_TABLES, ...RES_CHILD_TABLES];
const AUDIT = [["admin_action_logs", "class_id"], ["admin_action_logs", "reservation_id"]];

/** 현재 DB 상태를 계획과 같은 모양으로 읽는다(읽기 전용). 조회 실패는 예외 — 조회 실패는 삭제 근거가 아니다. */
export async function readLive(client, classIds, planProfileIds = []) {
  const classes = await client.get(`classes?id=${inList(classIds)}&select=*`);
  const reservations = await client.get(`reservations?class_id=${inList(classIds)}&select=*`);
  const resIds = reservations.map((r) => r.id);
  const children = {};
  for (const t of CHILD_TABLES) children[t] = await client.get(`${t}?class_id=${inList(classIds)}&select=*`);
  for (const t of RES_CHILD_TABLES) children[t] = resIds.length ? await client.get(`${t}?reservation_id=${inList(resIds)}&select=*`) : [];
  const audit = {
    class_id: (await client.get(`admin_action_logs?class_id=${inList(classIds)}&select=id`)).length,
    reservation_id: resIds.length ? (await client.get(`admin_action_logs?reservation_id=${inList(resIds)}&select=id`)).length : 0,
  };
  const profileIds = [...new Set([...reservations.map((r) => r.profile_id), ...planProfileIds])];
  const profiles = profileIds.length ? await client.get(`profiles?id=${inList(profileIds)}&select=id,account_id,deleted_at,is_primary`) : [];
  const memIds = [...new Set(reservations.map((r) => r.membership_id).filter(Boolean))];
  const memberships = memIds.length ? await client.get(`memberships?id=${inList(memIds)}&select=id,profile_id,status,remaining_count,total_count`) : [];
  return { classes, reservations, children, audit, profiles, memberships };
}

const memSig = (m) => stable({ id: m.id, profile_id: m.profile_id, status: m.status, remaining_count: m.remaining_count, total_count: m.total_count });

/** 계획 스냅샷 생성(생성기와 테스트가 공용). allowedProfiles 는 호출자가 확인한 {profileId, accountId, basis, evidence}. */
export async function buildPlanSnapshot(client, classIds, allowedProfiles, meta = {}) {
  const live = await readLive(client, classIds, allowedProfiles.map((p) => p.profileId));
  const sh = (rows) => rows.map((r) => ({ id: r.id, rowSha256: rowSha(r) })).sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 2, ...meta,
    wording: "approvalCandidate = 정황 근거가 있는 일회성 정리 승인 후보. 소유 증명이 아니다(ownershipProven=false).",
    allowedProfiles,
    classes: live.classes.map((c) => ({ id: c.id, centerId: c.center_id, title: c.title, createdAt: c.created_at, rowSha256: rowSha(c) })).sort((a, b) => a.id.localeCompare(b.id)),
    reservations: live.reservations.map((r) => ({ id: r.id, classId: r.class_id, profileId: r.profile_id, membershipId: r.membership_id, status: r.status, createdAt: r.created_at, rowSha256: rowSha(r) })).sort((a, b) => a.id.localeCompare(b.id)),
    children: Object.fromEntries(Object.entries(live.children).map(([t, rows]) => [t, sh(rows)])),
    linkedMemberships: live.memberships.map((m) => ({ id: m.id, profile_id: m.profile_id, status: m.status, remaining_count: m.remaining_count, total_count: m.total_count })).sort((a, b) => a.id.localeCompare(b.id)),
    auditRefs: live.audit,
  };
}

/** 계획 ↔ 현재 상태 대조. 반환: 불일치 문자열 배열(비어 있어야 진행). expect.reservations/classes 로 재개 시 기대 상태를 바꾼다. */
export function compareToPlan(plan, live, expect = { classes: "present", reservations: "present" }) {
  const m = [];
  const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const planClassIds = plan.classes.map((c) => c.id), planResIds = plan.reservations.map((r) => r.id);
  // 수업
  if (expect.classes === "present") {
    if (!eq(live.classes.map((c) => c.id), planClassIds)) m.push(`수업 id 집합이 계획과 다름(계획 ${planClassIds.length}, 현재 ${live.classes.length})`);
    const lc = byId(live.classes);
    for (const p of plan.classes) { const c = lc.get(p.id); if (c && rowSha(c) !== p.rowSha256) m.push(`수업 ${p.id}: 행 내용이 계획과 다름(센터/제목/상태 등)`); }
  } else if (live.classes.length) m.push(`수업이 이미 일부/전부 없어야 하는 단계인데 ${live.classes.length}건 존재`);
  // 예약: id 집합 + 행 전체 해시 + 연결(class/profile/membership) + 상태
  if (expect.reservations === "present") {
    if (!eq(live.reservations.map((r) => r.id), planResIds)) m.push(`예약 id 집합이 계획과 다름(계획 ${planResIds.length}, 현재 ${live.reservations.length})`);
    const lr = byId(live.reservations);
    for (const p of plan.reservations) {
      const r = lr.get(p.id); if (!r) continue;
      if (r.class_id !== p.classId) m.push(`예약 ${p.id}: 수업 연결이 다름`);
      if (r.profile_id !== p.profileId) m.push(`예약 ${p.id}: 프로필이 다름`);
      if ((r.membership_id ?? null) !== (p.membershipId ?? null)) m.push(`예약 ${p.id}: 수강권 연결이 다름`);
      if (r.status !== p.status) m.push(`예약 ${p.id}: 상태가 다름(${p.status} → ${r.status})`);
      if (rowSha(r) !== p.rowSha256) m.push(`예약 ${p.id}: 행 내용이 계획과 다름`);
    }
  } else if (live.reservations.length) m.push(`예약이 이미 없어야 하는 단계인데 ${live.reservations.length}건 존재`);
  // 프로필: 표시 이름이 아니라 고유번호·계정 번호
  const ap = new Map(plan.allowedProfiles.map((p) => [p.profileId, p])); const lp = byId(live.profiles);
  for (const r of live.reservations) {
    const a = ap.get(r.profile_id); if (!a) { m.push(`예약 ${r.id}: 승인 목록에 없는 프로필 ${r.profile_id}`); continue; }
    const p = lp.get(r.profile_id); if (!p) m.push(`예약 ${r.id}: 프로필 ${r.profile_id} 조회 불가`);
    else if (p.account_id !== a.accountId) m.push(`프로필 ${r.profile_id}: 계정 번호가 승인된 값과 다름`);
  }
  // 연결 데이터(자식 행): 고유번호 + 행 해시
  for (const t of [...CHILD_TABLES, ...RES_CHILD_TABLES]) {
    const want = plan.children[t] ?? []; const have = live.children[t] ?? [];
    const alive = (t === "reservation_goods_usages") ? expect.reservations === "present" : expect.classes === "present";
    if (!alive) { if (have.length) m.push(`${t}: 이미 없어야 하는데 ${have.length}건`); continue; }
    if (!eq(have.map((r) => r.id), want.map((r) => r.id))) m.push(`${t}: 고유번호 집합이 계획과 다름(계획 ${want.length}, 현재 ${have.length})`);
    const hm = byId(have); for (const w of want) { const r = hm.get(w.id); if (r && rowSha(r) !== w.rowSha256) m.push(`${t} ${w.id}: 행 내용이 계획과 다름`); }
  }
  // 감사 기록은 어떤 경우에도 0
  if (live.audit.class_id || live.audit.reservation_id) m.push(`admin_action_logs 참조 있음(수업 ${live.audit.class_id}, 예약 ${live.audit.reservation_id}) — 감사 기록이라 삭제 금지`);
  // 연결 수강권의 중요 상태(삭제가 수강권을 건드리지 않았는지와 계획 시점 값)
  if (expect.reservations === "present") {
    const lm = byId(live.memberships);
    for (const p of plan.linkedMemberships) { const x = lm.get(p.id); if (!x) m.push(`수강권 ${p.id}: 조회 불가`); else if (memSig(x) !== memSig(p)) m.push(`수강권 ${p.id}: 상태/잔여 횟수가 계획과 다름`); }
  }
  return m;
}

const writeAtomic = (file, data, mode = 0o600) => { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, data, { mode }); fs.renameSync(tmp, file); };
const journalFile = (dir, planSha) => path.join(dir, `ci-residue-journal-${planSha.slice(0, 12)}.json`);

/** 백업 본문 + 자체 digest. restore 가 digest 와 계획 해시로 검증한다. */
export function makeBackup(planSha, live) {
  const body = { planSha256: planSha, createdAt: new Date().toISOString(), classes: live.classes, reservations: live.reservations, children: live.children };
  return { ...body, digest: sha256(stable({ ...body, createdAt: undefined })) };
}
export function verifyBackup(plan, planSha, backup) {
  const errs = [];
  if (backup.planSha256 !== planSha) errs.push("백업의 계획 해시가 승인된 계획과 다름");
  const { digest, ...rest } = backup; if (sha256(stable({ ...rest, createdAt: undefined })) !== digest) errs.push("백업 digest 불일치(변조 또는 손상)");
  const tables = Object.keys(backup.children ?? {}); for (const t of tables) if (!WRITE_TABLES.includes(t)) errs.push(`허용되지 않은 테이블 ${t}`);
  const chk = (rows, planRows, label) => {
    const a = JSON.stringify(rows.map((r) => [r.id, rowSha(r)]).sort()); const b = JSON.stringify(planRows.map((r) => [r.id, r.rowSha256]).sort());
    if (a !== b) errs.push(`${label}: 백업 내용이 승인된 계획의 스냅샷과 다름`);
  };
  chk(backup.classes, plan.classes, "classes"); chk(backup.reservations, plan.reservations, "reservations");
  for (const t of [...CHILD_TABLES, ...RES_CHILD_TABLES]) chk(backup.children?.[t] ?? [], plan.children[t] ?? [], t);
  return errs;
}

/** 삭제. mode: "dry-run" | "execute" | "resume". 반환: {ok, mismatches, state}. 실패는 부분 상태를 state 에 담아 던진다. */
export async function runPurge({ client, plan, planSha, mode, backupDir, ack }) {
  const classIds = plan.classes.map((c) => c.id); const resIds = plan.reservations.map((r) => r.id);
  if (new Set(classIds).size !== classIds.length) throw new Error("계획의 수업 id 중복");
  if (!plan.approvalCandidate || plan.ownershipProven !== false) throw new Error("계획이 승인 후보 형식이 아님");
  if (mode !== "dry-run") { if (ack !== planSha.slice(0, 12)) throw new Error("PURGE_ACK(계획 해시 앞 12자리) 불일치"); if (!backupDir) throw new Error("backupDir 필요"); fs.mkdirSync(backupDir, { recursive: true }); }
  const jf = backupDir ? journalFile(backupDir, planSha) : null;
  const apIds = plan.allowedProfiles.map((p) => p.profileId);

  if (mode === "resume") {
    if (!jf || !fs.existsSync(jf)) throw new Error("이전 실행 기록(journal)이 없음 — '예약이 이미 없다'만으로는 재개하지 않음");
    const j = JSON.parse(fs.readFileSync(jf, "utf8"));
    if (j.planSha256 !== planSha) throw new Error("journal 의 계획 해시 불일치");
    const bfile = j.backupFile; if (!bfile || !fs.existsSync(bfile)) throw new Error("journal 이 가리키는 백업 파일이 없음");
    const backup = JSON.parse(fs.readFileSync(bfile, "utf8"));
    if (backup.digest !== j.backupDigest) throw new Error("백업 digest 가 journal 기록과 다름");
    const berr = verifyBackup(plan, planSha, backup); if (berr.length) throw new Error("백업 검증 실패: " + berr.join("; "));
    const phases = new Set(j.phases.map((p) => p.name));
    if (!phases.has("reservations:started")) throw new Error("journal 에 예약 삭제 시작 기록이 없음 — 재개 불가");
    if (phases.has("classes:done")) throw new Error("journal 상 수업 삭제까지 완료됨 — 재개할 것이 없음");
    const live = await readLive(client, classIds, apIds);
    const mism = compareToPlan(plan, live, { classes: "present", reservations: "absent" });
    if (mism.length) return { ok: false, mismatches: mism, state: "resume-refused" };
    j.phases.push({ name: "resume:started", at: new Date().toISOString() }); writeAtomic(jf, JSON.stringify(j, null, 1));
    await deleteClasses(client, plan, classIds); j.phases.push({ name: "classes:done", at: new Date().toISOString() }); writeAtomic(jf, JSON.stringify(j, null, 1));
    return await verifyGone(client, classIds, apIds);
  }

  if (mode === "execute" && fs.existsSync(jf)) throw new Error("이전 실행 기록(journal)이 이미 있음 — 새로 실행하지 않고 resume 로 대조하거나 사람이 확인");
  const live = await readLive(client, classIds, apIds);
  const mism = compareToPlan(plan, live, { classes: "present", reservations: "present" });
  if (mism.length) return { ok: false, mismatches: mism, state: "preflight-failed" };
  if (mode === "dry-run") return { ok: true, mismatches: [], state: "dry-run-ok" };

  const backup = makeBackup(planSha, live); const bfile = path.join(backupDir, `ci-residue-backup-${planSha.slice(0, 12)}-${Date.now()}.json`);
  writeAtomic(bfile, JSON.stringify(backup));
  const j = { planSha256: planSha, startedAt: new Date().toISOString(), backupFile: bfile, backupDigest: backup.digest, phases: [{ name: "backup:done", at: new Date().toISOString() }] };
  writeAtomic(jf, JSON.stringify(j, null, 1));
  j.phases.push({ name: "reservations:started", at: new Date().toISOString() }); writeAtomic(jf, JSON.stringify(j, null, 1));
  if (resIds.length) {
    const gone = await client.del(`reservations?id=${inList(resIds)}&class_id=${inList(classIds)}`);
    const planSha_ = new Map(plan.reservations.map((r) => [r.id, r.rowSha256]));
    if (gone.length !== resIds.length || gone.some((r) => planSha_.get(r.id) !== rowSha(r))) { throw Object.assign(new Error("삭제된 예약이 계획과 다름 — 즉시 중단, 백업과 대조 필요"), { state: "reservations-mismatch" }); }
  }
  j.phases.push({ name: "reservations:done", at: new Date().toISOString() }); writeAtomic(jf, JSON.stringify(j, null, 1));
  j.phases.push({ name: "classes:started", at: new Date().toISOString() }); writeAtomic(jf, JSON.stringify(j, null, 1));
  await deleteClasses(client, plan, classIds);
  j.phases.push({ name: "classes:done", at: new Date().toISOString() }); writeAtomic(jf, JSON.stringify(j, null, 1));
  return await verifyGone(client, classIds, apIds);
}
async function deleteClasses(client, plan, classIds) {
  const centers = [...new Set(plan.classes.map((c) => c.centerId))]; if (centers.length !== 1) throw new Error("센터가 여러 개 — 계획 재검토 필요");
  const gone = await client.del(`classes?id=${inList(classIds)}&center_id=eq.${centers[0]}`);
  const want = new Map(plan.classes.map((c) => [c.id, c.rowSha256]));
  if (gone.length !== classIds.length || gone.some((c) => want.get(c.id) !== rowSha(c))) throw Object.assign(new Error("삭제된 수업이 계획과 다름 — 즉시 중단, 백업과 대조 필요"), { state: "classes-mismatch" });
}
async function verifyGone(client, classIds, apIds) {
  const live = await readLive(client, classIds, apIds);
  const left = live.classes.length + live.reservations.length + Object.values(live.children).reduce((s, r) => s + r.length, 0);
  return { ok: left === 0, mismatches: left ? [`사후 확인: 남은 행 ${left}건`] : [], state: left ? "post-verify-failed" : "purged" };
}

/** 복원. 기존 행을 무조건 건너뛰지 않는다: 같으면 skip, 다르면 쓰기 전에 전체 중단. 복원 후 실제 데이터를 백업과 대조한다. */
export async function runRestore({ client, plan, planSha, backup, execute, acceptNotificationSideEffects }) {
  const verr = verifyBackup(plan, planSha, backup); if (verr.length) return { ok: false, errors: verr, state: "backup-invalid" };
  const order = [["classes", backup.classes], ["reservations", backup.reservations], ...[...CHILD_TABLES, ...RES_CHILD_TABLES].map((t) => [t, backup.children?.[t] ?? []])];
  const toInsert = []; const conflicts = [];
  for (const [t, rows] of order) {
    if (!WRITE_TABLES.includes(t)) return { ok: false, errors: [`허용되지 않은 테이블 ${t}`], state: "table-denied" };
    if (!rows.length) continue;
    const existing = byId(await client.get(`${t}?id=${inList(rows.map((r) => r.id))}&select=*`));
    const fresh = [];
    for (const r of rows) { const e = existing.get(r.id); if (!e) fresh.push(r); else if (rowSha(e) !== rowSha(r)) conflicts.push(`${t} ${r.id}: 같은 고유번호의 행이 있으나 백업과 다름`); }
    if (fresh.length) toInsert.push([t, fresh]);
  }
  if (conflicts.length) return { ok: false, errors: conflicts, state: "conflict" };
  const summary = toInsert.map(([t, r]) => `${t}:${r.length}`);
  if (!execute) return { ok: true, errors: [], state: "dry-run-ok", wouldInsert: summary };
  if (toInsert.some(([t]) => t === "reservations") && !acceptNotificationSideEffects) return { ok: false, errors: ["예약 재삽입은 notify_reservation_insert 트리거로 알림(및 pg_net 웹푸시) 부수 효과를 일으킴 — acceptNotificationSideEffects 필요"], state: "side-effects-not-accepted" };
  const done = [];
  try {
    for (const [t, rows] of toInsert) { const got = await client.post(t, rows); if (got.length !== rows.length) throw new Error(`${t}: 삽입 결과 건수 불일치`); done.push(`${t}:${rows.length}`); }
  } catch (e) { return { ok: false, errors: [`복원 중단(부분 복원 상태 가능 — 삽입 완료: ${done.join(",") || "없음"}): ${e.message}`], state: "partial" }; }
  // 복원 후 실제 데이터 대조
  const bad = [];
  for (const [t, rows] of order) { if (!rows.length) continue; const live = byId(await client.get(`${t}?id=${inList(rows.map((r) => r.id))}&select=*`)); for (const r of rows) { const e = live.get(r.id); if (!e) bad.push(`${t} ${r.id}: 복원 후 없음`); else if (rowSha(e) !== rowSha(r)) bad.push(`${t} ${r.id}: 복원 후 내용이 백업과 다름`); } }
  return { ok: bad.length === 0, errors: bad, state: bad.length ? "post-verify-failed" : "restored", inserted: done };
}
