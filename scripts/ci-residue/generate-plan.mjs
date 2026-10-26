#!/usr/bin/env node
/*
  읽기 전용 정리 계획 생성기(공유 DEV 에 GET 만 보낸다). 쓰기 없음. 자격 증명·이메일은 출력/저장하지 않는다(고유번호만).
  사용: PLAN_ENV_FILE=<env 파일> node generate-plan.mjs <ids.txt> <ci-log-evidence.json> <출력 기본경로(확장자 제외)>
  판정 용어: approvalCandidate = "정황 근거가 있는 일회성 정리 승인 후보". 소유권이 증명됐다는 뜻이 아니다(ownershipProven=false).
*/
import fs from "node:fs";
import { assertTarget, buildPlanSnapshot, makeClient, sha256, stable, rowSha } from "./core.mjs";

const SHARED_DEV_REF = "jdglfvwdnkjnraqdxuuj", PRODUCTION_REF = "bxntqggkfwnhcczsbqtj";
const [idsFile, evFile, outBase] = process.argv.slice(2);
const die = (m) => { console.error("ABORT: " + m); process.exit(2); };
if (!idsFile || !evFile || !outBase || !process.env.PLAN_ENV_FILE) die("인자/PLAN_ENV_FILE 필요");
const env = Object.fromEntries(fs.readFileSync(process.env.PLAN_ENV_FILE, "utf8").split("\n").filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
let origin; try { origin = assertTarget(env.NEXT_PUBLIC_SUPABASE_URL, { allowedRef: SHARED_DEV_REF, forbiddenRefs: [PRODUCTION_REF] }).origin; } catch (e) { die("대상 검증 실패: " + e.message); }
const key = env.SUPABASE_SERVICE_ROLE_KEY; if (!key) die("서비스 키 없음");
const client = makeClient({ baseUrl: origin, key });
const authGet = async (p, { notFoundOk = false } = {}) => { const r = await fetch(`${origin}/auth/v1/${p}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }); if (r.status === 404 && notFoundOk) return null; if (!r.ok) die(`auth 조회 실패(${r.status})`); return r.json(); };
const ids = fs.readFileSync(idsFile, "utf8").split("\n").filter(Boolean); const ev = JSON.parse(fs.readFileSync(evFile, "utf8"));

// 1) 테스트 계정 → 확인된 계정·인증 고유번호 (이메일로 auth 사용자를 찾되 이메일은 저장하지 않는다)
// 출처: PLAN_CI_ACCOUNTS_FILE(ci:dev:seed 가 만든 CI fixture 계정 파일 — GitHub Secrets 값의 출처로 docs/CI_DEV_SUPABASE_SETUP.md 에 문서화). *_EMAIL 키만 읽고 비밀번호 줄은 파싱하지 않는다.
// 이 파일의 이메일이 현재 GitHub Secrets 의 값과 같은지는 확인할 수 없다(Secrets 는 읽을 수 없음) — plan 에 그대로 기록한다.
const wanted = {}; let accountsSource = "PLAN_ENV_FILE";
if (process.env.PLAN_CI_ACCOUNTS_FILE) { accountsSource = "PLAN_CI_ACCOUNTS_FILE(ci-dev-accounts.env, seed 가 만든 CI fixture 계정)"; for (const line of fs.readFileSync(process.env.PLAN_CI_ACCOUNTS_FILE, "utf8").split("\n")) { const m = /^(?:export\s+)?TEST_(USER_A|USER_B|MANAGER_A|MANAGER_B|STAFF_A|STAFF_B)_EMAIL=(.*)$/.exec(line.trim()); if (m) wanted[m[1]] = m[2].trim().replace(/^["']|["']$/g, "").toLowerCase(); } }
else for (const l of ["USER_A", "USER_B", "MANAGER_A", "MANAGER_B", "STAFF_A", "STAFF_B"]) if (env[`TEST_${l}_EMAIL`]) wanted[l] = env[`TEST_${l}_EMAIL`].toLowerCase();
const authUsers = []; for (let page = 1; page < 50; page++) { const r = await authGet(`admin/users?page=${page}&per_page=200`); const list = r.users ?? r; authUsers.push(...list); if (list.length < 200) break; }
const testAccounts = [];
for (const [label, email] of Object.entries(wanted)) {
  const u = authUsers.find((x) => (x.email ?? "").toLowerCase() === email); if (!u) continue;
  const [a] = await client.get(`accounts?auth_id=eq.${u.id}&select=id,auth_id,created_at`); if (a) testAccounts.push({ label, authId: u.id, accountId: a.id, accountCreatedAt: a.created_at });
}
const userAEmail = wanted.USER_A; const [aLocal, aDomain] = (userAEmail ?? "@").split("@"); const aBase = aLocal.split("+")[0];

// 2) 예약 프로필을 고유번호로 분류(표시 이름은 근거로 쓰지 않는다 — 이름은 참고용으로만 기록하지 않음)
const live = await client.get(`reservations?class_id=in.(${ids.join(",")})&select=profile_id`);
const profIds = [...new Set(live.map((r) => r.profile_id))];
const profs = profIds.length ? await client.get(`profiles?id=in.(${profIds.join(",")})&select=id,account_id,is_primary,created_at,deleted_at`) : [];
const classRows = await client.get(`classes?id=in.(${ids.join(",")})&select=id,created_at`);
const minC = Math.min(...classRows.map((c) => Date.parse(c.created_at))), maxC = Math.max(...classRows.map((c) => Date.parse(c.created_at)));
const allowedProfiles = [], unknownProfiles = [];
const planClasses = await client.get(`classes?id=in.(${ids.join(",")})&select=id,title`); const lifecycleIds = new Set(planClasses.filter((c) => c.title.startsWith("E2E 생애주기")).map((c) => c.id));
const onlyOnLifecycleClasses = async (profileId) => { const rs = await client.get(`reservations?profile_id=eq.${profileId}&select=class_id`); return rs.length > 0 && rs.every((r) => lifecycleIds.has(r.class_id)); };
for (const p of profs) {
  const t = testAccounts.find((a) => a.accountId === p.account_id);
  if (t) { allowedProfiles.push({ profileId: p.id, accountId: p.account_id, basis: `test-account:${t.label}`, evidence: { authId: t.authId, profilePrimary: p.is_primary, profileCreatedAt: p.created_at, note: "계정 번호가 CI 테스트 이메일로 확인된 auth 사용자의 계정과 같음" } }); continue; }
  const [acct] = await client.get(`accounts?id=eq.${p.account_id}&select=id,auth_id,created_at,is_manager,is_platform_admin,deactivated_at`);
  const au = acct?.auth_id ? await authGet(`admin/users/${acct.auth_id}`, { notFoundOk: true }) : null;   // 탈퇴(delete-account)로 auth 사용자가 지워졌으면 null
  const em = (au?.email ?? "").toLowerCase(); const [l, d] = em.split("@");
  const plusAlias = !!au && d === aDomain && l.startsWith(`${aBase}+`);              // member-full-lifecycle 의 throwawayCreds 규칙: <TEST_USER_A 로컬파트>+<접미사>@<같은 도메인>
  const createdInWindow = !!acct && Date.parse(acct.created_at) >= minC - 30 * 60_000 && Date.parse(acct.created_at) <= maxC + 30 * 60_000;
  if (plusAlias && createdInWindow) allowedProfiles.push({ profileId: p.id, accountId: p.account_id, basis: "anonymized-throwaway-of:USER_A", evidence: { authId: acct.auth_id, accountCreatedAt: acct.created_at, profileCreatedAt: p.created_at, profileDeletedAt: p.deleted_at, authEmailIsPlusAliasOfTestUserA: true, accountCreatedWithinResidueWindow: true, note: "탈퇴 처리로 표시 이름이 익명화됐으나 계정의 auth 이메일이 TEST_USER_A 의 플러스 별칭(lifecycle 스펙 throwaway 규칙)이고 계정이 잔여 수업 생성 구간 안에 만들어짐 — 정황 근거" } });
  else if (!au && acct?.auth_id && createdInWindow && !acct.is_manager && !acct.is_platform_admin && (await onlyOnLifecycleClasses(p.id))) {
    // auth 사용자가 이미 삭제돼 이메일로 확인할 수 없는 익명화 계정 — 약한 정황 근거(별도 기록): 잔여 구간 안에 만들어진 일반 계정이고, 이 프로필의 예약이 전부 lifecycle 스펙 수업(제목 "E2E 생애주기")에만 있음
    allowedProfiles.push({ profileId: p.id, accountId: p.account_id, basis: "anonymized-throwaway(auth-user-deleted)", evidence: { authIdRecorded: acct.auth_id, authUserExists: false, accountCreatedAt: acct.created_at, accountCreatedWithinResidueWindow: true, accountIsManager: false, accountIsPlatformAdmin: false, profileCreatedAt: p.created_at, profileDeletedAt: p.deleted_at, reservationsOnlyOnLifecycleClasses: true, strength: "weak-circumstantial", note: "탈퇴로 auth 사용자가 삭제돼 TEST_USER_A 플러스 별칭 여부를 확인할 수 없음. 표시 이름 '탈퇴한 회원'은 판정에 쓰지 않았고(고유번호만), 위 사실들만 근거" } });
  } else unknownProfiles.push({ profileId: p.id, accountId: p.account_id, plusAlias, createdInWindow });
}

// 3) 스냅샷(행 전체 해시·연결 관계·자식 행·연결 수강권·감사 참조)
const spec = await (await fetch(`${origin}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })).json();
const VIEWS = new Set(["class_reservation_counts"]);
const refs = { classes: [], reservations: [] };
for (const [t, def] of Object.entries(spec.definitions ?? {})) for (const [c, p] of Object.entries(def.properties ?? {})) { const m = /Foreign Key to `(classes|reservations)\.id`/.exec(p.description ?? ""); if (m && !VIEWS.has(t)) refs[m[1]].push([t, c]); }
const KNOWN = new Set(["admin_action_logs.class_id", "admin_action_logs.reservation_id", "class_allowed_products.class_id", "class_trainers.class_id", "schedule_memos.class_id", "reservation_goods_usages.reservation_id", "reservations.class_id"]);
const unknownRefs = [...refs.classes, ...refs.reservations].map(([t, c]) => `${t}.${c}`).filter((x) => !KNOWN.has(x));
const snap = await buildPlanSnapshot(client, ids, allowedProfiles, {});
const resIds = snap.reservations.map((r) => r.id);
let notifications = "QUERY_FAILED"; try { notifications = resIds.length ? (await client.get(`notifications?data->>reservation_id=in.(${resIds.join(",")})&select=id`)).length : 0; } catch { /* 정보용 */ }

// 4) 클래스별 정황 근거(CI 로그 등장 + job 구간 포함) — 증명이 아니다
const classEvidence = snap.classes.map((c) => {
  const e = (ev[c.id] ?? []); const inside = e.filter((x) => Date.parse(c.createdAt) >= Date.parse(x.jobStart) && Date.parse(c.createdAt) <= Date.parse(x.jobEnd));
  const epoch = /(\d{13})$/.exec(c.title)?.[1];
  return { classId: c.id, ciLogJobWindowHit: inside.length > 0, ciLogMentions: inside.slice(0, 3).map((x) => ({ run: x.run, sha: x.sha, job: x.job, kind: x.kind })), titleEpochDeltaSec: epoch ? Math.abs(Date.parse(c.createdAt) - Number(epoch)) / 1000 : null };
});
const approvalCandidate = unknownProfiles.length === 0 && unknownRefs.length === 0 && classEvidence.every((c) => c.ciLogJobWindowHit) && snap.auditRefs.class_id === 0 && snap.auditRefs.reservation_id === 0 && snap.classes.length === ids.length;
const plan = {
  ...snap, generatedAt: new Date().toISOString(), target: { host: new URL(origin).hostname, note: "공유 DEV(mwhabit-ci-dev)" },
  approvalCandidate, ownershipProven: false, evidenceKind: "circumstantial",
  testAccounts: testAccounts.map(({ label, authId, accountId }) => ({ label, authId, accountId })), testAccountsSource: accountsSource + " — 이 이메일이 현재 GitHub Secrets 값과 같은지는 확인 불가",
  unknownProfiles, unknownReferencingColumns: unknownRefs, referencingColumns: refs, classEvidence,
  informational: { notificationsReferencingReservations: notifications, note: "알림은 FK 가 없어 삭제하지 않는다(정보용). 예약 재삽입(복원)은 notify_reservation_insert 트리거로 새 알림을 만든다." },
  sideEffects: [
    "예약 DELETE: BEFORE DELETE 트리거 reservation_goods_restore_on_delete — 차감된 대여 사용 기록(reservation_goods_usages.status='deducted')이 있으면 대여 수강권 remaining_count 를 +1 한다. 이 계획의 대여 사용 기록 수: " + (snap.children.reservation_goods_usages?.length ?? 0),
    "예약 DELETE 는 pass 수강권 remaining_count 를 돌려주지 않는다(직접 삭제, 환불 아님). 연결 수강권 상태는 linkedMemberships 로 기록·대조한다.",
    "수업 DELETE: 이 저장소 SQL 에서 classes 에 걸린 트리거를 찾지 못함(공유 DEV 의 pg_trigger 는 PostgREST 로 조회 불가 — 미확인). CASCADE 자식: class_allowed_products, class_trainers, schedule_memos.",
    "예약 INSERT(복원): AFTER INSERT 트리거 notify_reservation_insert 가 회원·센터 매니저에게 notifications 행을 만든다(웹푸시는 별도 pg_net/Edge Function 경로 가능 — 공유 DEV 에서는 미확인). BEFORE INSERT 트리거 reservations_guard_pg_refund_lock 이 환불 진행 중 수강권이면 삽입을 거부할 수 있다.",
  ],
  evidenceLimits: [
    "과거 생성 응답과 실행 식별자(UUID)는 사라졌고 복구할 수 없다(통과한 테스트는 trace 를 남기지 않고, 당시 코드는 제목에 실행 UUID 를 쓰지 않았고, manifest 는 러너와 함께 사라짐). 이 사실을 그대로 인정한다.",
    "따라서 이 계획은 소유권을 증명하지 않는다. 근거는 같은 CI job 로그에 id 등장 + 생성 시각이 그 job 구간 안 + 제목의 Date.now() 일치 + 예약 프로필이 확인된 테스트 계정/익명화된 throwaway 계정이라는 정황이다.",
    "삭제는 사람이 이 정황 근거를 보고 '일회성 정리'를 승인한 뒤에만 한다.",
  ],
};
fs.writeFileSync(outBase + ".json", JSON.stringify(plan, null, 1));
const planSha = sha256(stable(plan));
let md = `# 공유 DEV CI 잔여 수업 정리 계획 v2 (읽기 전용 조회 — 아무것도 삭제하지 않았음)\n\n- 생성: ${plan.generatedAt} · 대상: ${plan.target.host} · GET 만\n- **판정: ${approvalCandidate ? "정황 근거가 있는 일회성 정리 승인 후보(approvalCandidate)" : "승인 후보 조건 미충족(아래 사유)"}** — 소유권 증명 아님(ownershipProven=false)\n- 계획 해시(sha256 of canonical JSON): \`${planSha}\`\n- 수업 ${snap.classes.length} · 예약 ${snap.reservations.length} · 연결 수강권 ${snap.linkedMemberships.length} · 자식 행 ${Object.entries(snap.children).map(([t, r]) => `${t}:${r.length}`).join(", ")} · 감사 참조 ${JSON.stringify(snap.auditRefs)}\n- 승인 목록 프로필(고유번호 기준) ${allowedProfiles.length}개 · 미확인 프로필 ${unknownProfiles.length}개 · 미지의 참조 컬럼 ${unknownRefs.length}개\n\n## 승인된 프로필 근거(표시 이름 아님)\n${allowedProfiles.map((p) => `- ${p.profileId} / 계정 ${p.accountId} / ${p.basis}`).join("\n")}\n\n## 근거의 한계\n${plan.evidenceLimits.map((x) => "- " + x).join("\n")}\n\n## 부수 효과 조사\n${plan.sideEffects.map((x) => "- " + x).join("\n")}\n\n## 수업별 정황 근거\n${classEvidence.map((c) => `- ${c.classId}: CI 로그 job 구간 일치 ${c.ciLogJobWindowHit ? "예" : "아니오"}${c.titleEpochDeltaSec != null ? `, 제목 epoch 차 ${c.titleEpochDeltaSec.toFixed(1)}초` : ""}`).join("\n")}\n`;
fs.writeFileSync(outBase + ".md", md);
console.log(`approvalCandidate=${approvalCandidate} unknownProfiles=${unknownProfiles.length} unknownRefs=${unknownRefs.length}\nplanSha256=${planSha}`);
