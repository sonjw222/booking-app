/*
  공유 DEV CI 잔여 정리 스크립트(scripts/ci-residue/core.mjs)의 격리 PostgreSQL+PostgREST 회귀.
  이 파일은 로컬 격리 DB 에서만 실행한다 — 공유 DEV/운영에는 접속하지 않으며, CLI 의 정확한 HTTPS 호스트 검증은 순수 단위로만 확인한다.
  같은 코드(readLive/compareToPlan/runPurge/runRestore)를 CLI 도 쓴다.
*/
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL_, jwt, sql, ID } from "./support";
import * as coreModule from "../../scripts/ci-residue/core.mjs";
// 순수 JS(.mjs) 코어 — 호출 쪽 타입은 느슨하게 둔다(CLI 와 같은 코드를 그대로 실행하는 것이 목적)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { assertTarget, buildPlanSnapshot, compareToPlan, makeClient, readLive, rowSha, runPurge, runRestore, sha256, stable, verifyBackup } = coreModule as any;

type Fault = { method: string; urlPart: string };
const faultyFetch = (faults: Fault[]): typeof fetch => async (input, init) => {
  const method = (init?.method ?? "GET").toUpperCase(); const url = String(input);
  if (faults.some((f) => f.method === method && url.includes(f.urlPart))) return new Response(JSON.stringify({ message: "injected" }), { status: 500, headers: { "content-type": "application/json" } });
  return fetch(url, init);
};
const client = (faults: Fault[] = []) => makeClient({ baseUrl: URL_, key: jwt("service_role"), restPrefix: "", fetchImpl: faultyFetch(faults) });

const CENTER = ID.centerPub, OTHER_CENTER = ID.centerPriv;
const P = { A1: ID.pA1, A2: ID.pA2, B1: ID.pB1, C1: "c1000000-0000-0000-0000-0000000000c1" };
const ACCT = { A: "a0000000-0000-0000-0000-00000000000a", B: "b0000000-0000-0000-0000-00000000000b", C: "c0000000-0000-0000-0000-00000000000c" };
const ALLOWED = [
  { profileId: P.A1, accountId: ACCT.A, basis: "test-account:USER_A(격리 시험)" },
  { profileId: P.A2, accountId: ACCT.A, basis: "test-account:USER_A 의 비-primary 프로필(격리 시험)" },
  { profileId: P.B1, accountId: ACCT.B, basis: "test-account:USER_B(격리 시험)" },
];
const one = (q: string) => sql(q).split("\n")[0];
const future = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const created: string[] = [];
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ci-residue-")); dirs.push(d); return d; };

async function seed() {
  const tag = randomUUID().slice(0, 8);
  const cls = (n: number) => one(`insert into classes(center_id,title,start_time,end_time,capacity) values ('${CENTER}','CIR-${tag}-${n}','${future(30 + n)}','${future(31 + n)}',5) returning id`);
  const [c1, c2, c3] = [cls(1), cls(2), cls(3)]; created.push(c1, c2, c3);
  const m1 = one(`insert into memberships(profile_id,center_id,product_name,total_count,remaining_count) values ('${P.A1}','${CENTER}','CIR 패스 ${tag}',5,4) returning id`);
  const m2 = one(`insert into memberships(profile_id,center_id,product_name,total_count,remaining_count) values ('${P.A1}','${CENTER}','CIR 다른 패스 ${tag}',5,5) returning id`);
  const res = (c: string, p: string, st: string, m?: string) => one(`insert into reservations(class_id,profile_id,status${m ? ",membership_id" : ""}) values ('${c}','${p}','${st}'${m ? `,'${m}'` : ""}) returning id`);
  const r1 = res(c1, P.A1, "confirmed", m1), r2 = res(c1, P.A2, "waitlisted"), r3 = res(c2, P.B1, "confirmed");
  one(`insert into class_allowed_products(class_id,product_id) values ('${c1}','${ID.prodFree}') returning class_id`);
  // 계획 밖: 같은 센터·같은 제목 형태의 다른 수업(+예약)
  const outside = one(`insert into classes(center_id,title,start_time,end_time,capacity) values ('${CENTER}','CIR-${tag}-outside','${future(40)}','${future(41)}',5) returning id`); created.push(outside);
  const outsideRes = res(outside, P.B1, "confirmed");
  const plan = await buildPlanSnapshot(client(), [c1, c2, c3], ALLOWED, { approvalCandidate: true, ownershipProven: false, target: "isolated-test" });
  return { tag, c: [c1, c2, c3], m1, m2, r: [r1, r2, r3], outside, outsideRes, plan, planSha: sha256(stable(plan)) };
}
const exists = (t: string, id: string) => one(`select count(*) from ${t} where id='${id}'`) === "1";
const count = (q: string) => Number(one(q));
afterAll(() => {
  if (created.length) { const ids = created.map((i) => `'${i}'`).join(","); sql(`delete from admin_action_logs where class_id in (${ids}); delete from reservations where class_id in (${ids}); delete from classes where id in (${ids}); delete from memberships where product_name like 'CIR %'; delete from notifications where title in (select title from notifications limit 0)`); }
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

describe("정확한 HTTPS 호스트 검증", () => {
  const opt = { allowedRef: "jdglfvwdnkjnraqdxuuj", forbiddenRefs: ["bxntqggkfwnhcczsbqtj"] };
  it("정확한 <ref>.supabase.co(https)만 통과", () => { expect(assertTarget("https://jdglfvwdnkjnraqdxuuj.supabase.co", opt).host).toBe("jdglfvwdnkjnraqdxuuj.supabase.co"); expect(assertTarget("https://jdglfvwdnkjnraqdxuuj.supabase.co/", opt).origin).toBe("https://jdglfvwdnkjnraqdxuuj.supabase.co"); });
  it("문자열 포함만으로는 통과하지 못한다", () => {
    for (const bad of [
      "https://jdglfvwdnkjnraqdxuuj.supabase.co.evil.com", "https://evil.com/jdglfvwdnkjnraqdxuuj.supabase.co", "https://evil.com?jdglfvwdnkjnraqdxuuj.supabase.co",
      "https://jdglfvwdnkjnraqdxuuj.supabase.co@evil.com", "https://user:pw@jdglfvwdnkjnraqdxuuj.supabase.co", "https://jdglfvwdnkjnraqdxuuj.supabase.co:8443",
      "http://jdglfvwdnkjnraqdxuuj.supabase.co", "https://xjdglfvwdnkjnraqdxuuj.supabase.co", "https://jdglfvwdnkjnraqdxuuj.supabase.co/rest/v1", "https://jdglfvwdnkjnraqdxuuj.supabase.co/?a=1",
      "https://bxntqggkfwnhcczsbqtj.supabase.co", "http://127.0.0.1:3203", "", "not a url",
    ]) expect(() => assertTarget(bad, opt), bad).toThrow();
  });
});

describe("사전 대조: 건수가 같아도 내용이 달라지면 중단", () => {
  const dry = async (s: Awaited<ReturnType<typeof seed>>) => runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "dry-run" });
  it("변경이 없으면 dry-run 통과(쓰기 없음)", async () => { const s = await seed(); const r = await dry(s); expect(r.ok).toBe(true); expect(exists("classes", s.c[0])).toBe(true); });
  const cases: Array<[string, (s: Awaited<ReturnType<typeof seed>>) => void, RegExp]> = [
    ["예약 상태가 바뀜(건수 동일)", (s) => sql(`update reservations set status='attended' where id='${s.r[0]}'`), /상태가 다름/],
    ["예약의 수강권 연결이 바뀜(건수 동일)", (s) => sql(`update reservations set membership_id='${s.m2}' where id='${s.r[0]}'`), /수강권 연결이 다름/],
    ["예약 프로필이 승인 목록 밖 프로필로 바뀜(건수 동일)", (s) => sql(`update reservations set profile_id='${P.C1}' where id='${s.r[2]}'`), /프로필/],
    ["예약 한 건을 지우고 다른 예약을 추가(건수 동일, id 다름)", (s) => { sql(`delete from reservations where id='${s.r[2]}'`); sql(`insert into reservations(class_id,profile_id,status) values ('${s.c[1]}','${P.B1}','confirmed')`); }, /id 집합이 계획과 다름/],
    ["자식 행(class_allowed_products)의 상품이 바뀜(건수 동일)", (s) => sql(`delete from class_allowed_products where class_id='${s.c[0]}'; insert into class_allowed_products(class_id,product_id) values ('${s.c[0]}','${ID.prodOther}')`), /class_allowed_products/],
    ["수업 행 내용이 바뀜", (s) => sql(`update classes set capacity=capacity+1 where id='${s.c[2]}'`), /행 내용이 계획과 다름/],
    ["연결 수강권의 잔여 횟수가 바뀜", (s) => sql(`update memberships set remaining_count=remaining_count-1 where id='${s.m1}'`), /수강권/],
    ["수업이 다른 센터로 옮겨짐", (s) => sql(`update classes set center_id='${OTHER_CENTER}' where id='${s.c[2]}'`), /행 내용이 계획과 다름/],
    ["승인 목록 프로필의 계정 번호가 달라짐(이름은 그대로)", (s) => sql(`update profiles set account_id='${ACCT.C}' where id='${P.B1}'`), /계정 번호/],
  ];
  for (const [name, mutate, re] of cases) {
    it(name, async () => {
      const s = await seed(); try { mutate(s); const r = await dry(s); expect(r.ok).toBe(false); expect(r.mismatches.join("\n")).toMatch(re);
        const ex = await runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "execute", backupDir: tmp(), ack: s.planSha.slice(0, 12) });
        expect(ex.ok).toBe(false); expect(count(`select count(*) from classes where id in ('${s.c.join("','")}')`)).toBe(3); // 아무것도 지워지지 않음
      } finally { sql(`update profiles set account_id='${ACCT.B}' where id='${P.B1}'; update classes set center_id='${CENTER}' where id='${s.c[2]}'`); }
    });
  }
  it("감사 기록(admin_action_logs) 참조가 생기면 중단", async () => {
    const s = await seed(); sql(`insert into admin_action_logs(center_id,reservation_id,action_type,reservation_type,reservation_source,admin_id,member_profile_id,class_id) values ('${CENTER}','${s.r[0]}','CANCEL_FREE','MEMBER','USER','${ACCT.C}','${P.A1}','${s.c[0]}')`);
    const r = await dry(s); expect(r.ok).toBe(false); expect(r.mismatches.join()).toContain("감사 기록");
  });
  it("조회 실패는 삭제 근거가 아니다(예외, 아무것도 지우지 않음)", async () => {
    const s = await seed();
    await expect(runPurge({ client: client([{ method: "GET", urlPart: "/reservations?" }]), plan: s.plan, planSha: s.planSha, mode: "dry-run" })).rejects.toThrow(/조회/);
    expect(exists("classes", s.c[0])).toBe(true);
  });
  it("승인 후보 형식이 아닌(소유 증명을 주장하는) 계획은 거부", async () => {
    const s = await seed(); await expect(runPurge({ client: client(), plan: { ...s.plan, ownershipProven: true }, planSha: s.planSha, mode: "dry-run" })).rejects.toThrow(/승인 후보/);
  });
});

describe("삭제 실행·부수 효과", () => {
  it("계획 밖 행(같은 센터)은 그대로 두고 계획 대상만 삭제 + 백업/journal 기록, 수강권 횟수·알림은 변하지 않음", async () => {
    const s = await seed(); const dir = tmp();
    const memBefore = one(`select remaining_count from memberships where id='${s.m1}'`); const notifBefore = count(`select count(*) from notifications`);
    const r = await runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "execute", backupDir: dir, ack: s.planSha.slice(0, 12) });
    expect(r.state).toBe("purged"); expect(r.ok).toBe(true);
    for (const c of s.c) expect(exists("classes", c)).toBe(false); for (const x of s.r) expect(exists("reservations", x)).toBe(false);
    expect(count(`select count(*) from class_allowed_products where class_id='${s.c[0]}'`)).toBe(0);
    expect(exists("classes", s.outside)).toBe(true); expect(exists("reservations", s.outsideRes)).toBe(true);   // 계획 밖은 보존
    expect(one(`select remaining_count from memberships where id='${s.m1}'`)).toBe(memBefore);                   // 예약 삭제는 수강권 횟수를 돌려주지 않음(goods 사용 기록이 없으면)
    expect(count(`select count(*) from notifications`)).toBe(notifBefore);                                        // 삭제는 알림을 만들지 않음
    const files = fs.readdirSync(dir); expect(files.some((f) => f.startsWith("ci-residue-backup-"))).toBe(true); expect(files.some((f) => f.startsWith("ci-residue-journal-"))).toBe(true);
    expect(fs.statSync(path.join(dir, files.find((f) => f.startsWith("ci-residue-backup-"))!)).mode & 0o777).toBe(0o600);
  });
  it("ACK 가 틀리면 실행하지 않는다", async () => {
    const s = await seed(); await expect(runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "execute", backupDir: tmp(), ack: "wrong" })).rejects.toThrow(/PURGE_ACK/); expect(exists("classes", s.c[0])).toBe(true);
  });
  it("[조사] 예약 삭제 트리거(reservation_goods_restore_on_delete): 차감된 대여 사용 기록이 있으면 대여 수강권 횟수가 +1 되고 사용 기록은 CASCADE 로 삭제된다", async () => {
    const s = await seed();
    const gm = one(`insert into memberships(profile_id,center_id,product_name,total_count,remaining_count) values ('${P.A1}','${CENTER}','CIR 대여권 ${s.tag}',5,3) returning id`);
    sql(`insert into reservation_goods_usages(reservation_id,goods_membership_id,center_id,profile_id,product_name_snapshot,status) values ('${s.r[0]}','${gm}','${CENTER}','${P.A1}','대여','deducted')`);
    const plan = await buildPlanSnapshot(client(), s.c, ALLOWED, { approvalCandidate: true, ownershipProven: false }); const planSha = sha256(stable(plan));
    expect(plan.children.reservation_goods_usages).toHaveLength(1);          // 계획이 이 연결 데이터를 고유번호로 기록
    const r = await runPurge({ client: client(), plan, planSha, mode: "execute", backupDir: tmp(), ack: planSha.slice(0, 12) });
    expect(r.ok).toBe(true);
    expect(one(`select remaining_count from memberships where id='${gm}'`)).toBe("4");                  // 부수 효과: 3 → 4
    expect(count(`select count(*) from reservation_goods_usages where reservation_id='${s.r[0]}'`)).toBe(0);
  });
});

describe("중간 실패와 재개 — 검증된 백업과 이전 실행 기록(journal)을 대조", () => {
  const failClassDelete = [{ method: "DELETE", urlPart: "/classes?" }];
  async function interrupted() {
    const s = await seed(); const dir = tmp();
    await expect(runPurge({ client: client(failClassDelete), plan: s.plan, planSha: s.planSha, mode: "execute", backupDir: dir, ack: s.planSha.slice(0, 12) })).rejects.toThrow(/삭제 수업|삭제/);
    return { s, dir };
  }
  it("예약만 지워지고 수업 삭제가 실패한 중간 상태가 journal 에 남고, 새 실행은 거부된다", async () => {
    const { s, dir } = await interrupted();
    expect(count(`select count(*) from reservations where class_id in ('${s.c.join("','")}')`)).toBe(0); expect(exists("classes", s.c[0])).toBe(true);
    const j = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith("ci-residue-journal-"))!), "utf8"));
    expect(j.phases.map((p: { name: string }) => p.name)).toEqual(["backup:done", "reservations:started", "reservations:done", "classes:started"]);
    await expect(runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "execute", backupDir: dir, ack: s.planSha.slice(0, 12) })).rejects.toThrow(/journal|이전 실행 기록/);
  });
  it("'예약이 이미 없다'는 이유만으로는 재개하지 않는다(journal 없는 디렉터리)", async () => {
    const { s } = await interrupted();
    await expect(runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "resume", backupDir: tmp(), ack: s.planSha.slice(0, 12) })).rejects.toThrow(/이전 실행 기록/);
    expect(exists("classes", s.c[0])).toBe(true);
  });
  it("백업 파일이 변조됐거나 journal 의 계획 해시가 다르면 재개 거부", async () => {
    const { s, dir } = await interrupted();
    const bfile = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith("ci-residue-backup-"))!); const orig = fs.readFileSync(bfile, "utf8");
    const b = JSON.parse(orig); b.reservations[0].status = "cancelled"; fs.writeFileSync(bfile, JSON.stringify(b));
    await expect(runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "resume", backupDir: dir, ack: s.planSha.slice(0, 12) })).rejects.toThrow(/digest/);
    fs.writeFileSync(bfile, orig);
    const jf = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith("ci-residue-journal-"))!); const j = JSON.parse(fs.readFileSync(jf, "utf8")); j.planSha256 = "0".repeat(64); fs.writeFileSync(jf, JSON.stringify(j));
    await expect(runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "resume", backupDir: dir, ack: s.planSha.slice(0, 12) })).rejects.toThrow(/해시/);
    expect(exists("classes", s.c[0])).toBe(true);
  });
  it("그 사이 수업 행이 바뀌었거나 예약이 다시 생겼으면 재개 거부, 정상이면 수업만 삭제하고 완료", async () => {
    const { s, dir } = await interrupted();
    sql(`update classes set capacity=capacity+1 where id='${s.c[2]}'`);
    let r = await runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "resume", backupDir: dir, ack: s.planSha.slice(0, 12) }); expect(r.ok).toBe(false); expect(r.state).toBe("resume-refused");
    sql(`update classes set capacity=capacity-1 where id='${s.c[2]}'`);
    sql(`insert into reservations(class_id,profile_id,status) values ('${s.c[1]}','${P.B1}','confirmed')`);
    r = await runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "resume", backupDir: dir, ack: s.planSha.slice(0, 12) }); expect(r.ok).toBe(false);
    sql(`delete from reservations where class_id='${s.c[1]}'`);
    r = await runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "resume", backupDir: dir, ack: s.planSha.slice(0, 12) });
    expect(r.state).toBe("purged"); for (const c of s.c) expect(exists("classes", c)).toBe(false); expect(exists("classes", s.outside)).toBe(true);
    await expect(runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "resume", backupDir: dir, ack: s.planSha.slice(0, 12) })).rejects.toThrow(/완료|재개/); // 다시 재개할 것이 없음
  });
  it("예약 삭제 요청이 실패하면 아무것도 지워지지 않고 journal 은 '예약 삭제 시작'에서 멈춘다(재개는 상태 대조 후에만)", async () => {
    const s = await seed(); const dir = tmp();
    await expect(runPurge({ client: client([{ method: "DELETE", urlPart: "/reservations?" }]), plan: s.plan, planSha: s.planSha, mode: "execute", backupDir: dir, ack: s.planSha.slice(0, 12) })).rejects.toThrow();
    expect(count(`select count(*) from reservations where class_id in ('${s.c.join("','")}')`)).toBe(3);
    const r = await runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "resume", backupDir: dir, ack: s.planSha.slice(0, 12) });
    expect(r.ok).toBe(false); expect(r.mismatches.join()).toMatch(/예약이 이미 없어야 하는 단계/); // 예약이 남아 있으므로 재개가 아니라 새로 판단해야 함
  });
});

describe("복원 — 승인된 계획·허용 테이블·기존 행 대조·복원 후 실데이터 대조", () => {
  async function purged() { const s = await seed(); const dir = tmp(); await runPurge({ client: client(), plan: s.plan, planSha: s.planSha, mode: "execute", backupDir: dir, ack: s.planSha.slice(0, 12) });
    const backup = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith("ci-residue-backup-"))!), "utf8")); return { s, dir, backup }; }
  it("정상 복원: 삽입 후 실제 데이터가 백업과 같고, 예약 재삽입의 알림 부수 효과가 기록된다", async () => {
    const { s, backup } = await purged();
    const dry = await runRestore({ client: client(), plan: s.plan, planSha: s.planSha, backup, execute: false }); expect(dry.state).toBe("dry-run-ok"); expect(dry.wouldInsert).toEqual(expect.arrayContaining(["classes:3", "reservations:3", "class_allowed_products:1"]));
    const blocked = await runRestore({ client: client(), plan: s.plan, planSha: s.planSha, backup, execute: true }); expect(blocked.state).toBe("side-effects-not-accepted"); expect(exists("classes", s.c[0])).toBe(false);
    const notifBefore = count(`select count(*) from notifications`);
    const r = await runRestore({ client: client(), plan: s.plan, planSha: s.planSha, backup, execute: true, acceptNotificationSideEffects: true });
    expect(r.state).toBe("restored"); expect(r.ok).toBe(true);
    const live = await readLive(client(), s.c, []); expect(live.classes.map((c: { id: string }) => c.id).sort()).toEqual([...s.c].sort());
    for (const row of backup.reservations) expect(rowSha(live.reservations.find((x: { id: string }) => x.id === row.id))).toBe(rowSha(row));  // created_at 포함 전체 행 동일
    expect(count(`select count(*) from notifications`)).toBeGreaterThan(notifBefore);   // notify_reservation_insert 트리거: 복원은 알림 행을 만든다(부수 효과, 이 DB 에서 실측)
    expect(compareToPlan(s.plan, live)).toEqual([]);
  });
  it("같은 행이 이미 있으면 건너뛰고(백업과 동일), 다르면 쓰기 전에 전체 중단한다", async () => {
    const { s, backup } = await purged();
    const r1 = await runRestore({ client: client(), plan: s.plan, planSha: s.planSha, backup, execute: true, acceptNotificationSideEffects: true }); expect(r1.ok).toBe(true);
    const again = await runRestore({ client: client(), plan: s.plan, planSha: s.planSha, backup, execute: true, acceptNotificationSideEffects: true }); expect(again.ok).toBe(true); expect(again.inserted).toEqual([]);   // 멱등
    sql(`delete from reservations where id='${s.r[2]}'; update classes set title = title || ' (변경)' where id='${s.c[0]}'`);
    const conflict = await runRestore({ client: client(), plan: s.plan, planSha: s.planSha, backup, execute: true, acceptNotificationSideEffects: true });
    expect(conflict.state).toBe("conflict"); expect(conflict.errors.join()).toContain("백업과 다름"); expect(exists("reservations", s.r[2])).toBe(false);   // 삭제된 예약도 다시 넣지 않고 전체 중단
  });
  it("백업이 승인된 계획과 다르거나 변조됐거나 허용 안 된 테이블/계획 밖 id 가 있으면 거부", async () => {
    const { s, backup } = await purged();
    const run = (b: unknown, sha = s.planSha) => runRestore({ client: client(), plan: s.plan, planSha: sha, backup: b, execute: true, acceptNotificationSideEffects: true });
    expect((await run(backup, "f".repeat(64))).state).toBe("backup-invalid");                                             // 다른 계획 해시
    expect((await run({ ...backup, reservations: backup.reservations.slice(1) })).state).toBe("backup-invalid");           // 변조(digest)
    const evil = { ...backup, children: { ...backup.children, accounts: [{ id: randomUUID(), is_platform_admin: true }] } }; const { digest, ...rest } = evil;
    evil.digest = sha256(stable({ ...rest, createdAt: undefined })); expect((await run(evil)).errors.join()).toContain("허용되지 않은 테이블");
    const extra = { ...backup, classes: [...backup.classes, { ...backup.classes[0], id: randomUUID() }] }; const { digest: d2, ...r2 } = extra; extra.digest = sha256(stable({ ...r2, createdAt: undefined }));
    expect((await run(extra)).state).toBe("backup-invalid");                                                                // 계획 밖 수업 id
    expect(exists("classes", s.c[0])).toBe(false);                                                                          // 어떤 경우에도 쓰기 없음
    expect(verifyBackup(s.plan, s.planSha, backup)).toEqual([]);
  });
  it("복원 중 삽입 실패는 부분 복원 상태를 명시하고, 복원 후 실데이터 대조가 불일치를 잡는다", async () => {
    const { s, backup } = await purged();
    const r = await runRestore({ client: client([{ method: "POST", urlPart: "/reservations" }]), plan: s.plan, planSha: s.planSha, backup, execute: true, acceptNotificationSideEffects: true });
    expect(r.state).toBe("partial"); expect(r.errors.join()).toContain("classes:3");
    expect(exists("classes", s.c[0])).toBe(true); expect(exists("reservations", s.r[0])).toBe(false);
    // 다시 실행하면 이미 복원된 수업은 동일해서 건너뛰고 나머지를 복원한다
    const r2 = await runRestore({ client: client(), plan: s.plan, planSha: s.planSha, backup, execute: true, acceptNotificationSideEffects: true }); expect(r2.state).toBe("restored");
  });
});
