/*
  Q01 회귀 — E2E 수업 소유권 정리(tests/e2e/fixtures/ownedClassCleanup.ts)를 "격리 PostgreSQL+PostgREST" 에서 실제로 검증한다.
  운영·공유 DEV 에는 접속하지 않는다(run.sh up 으로 띄운 로컬 컨테이너만). 삭제 시험도 이 격리 DB 안에서만 한다.
  장애 주입은 fetch 래퍼가 특정 요청만 500 으로 바꿔 수행한다(실제 DB 상태는 그대로 두고 응답만 실패).
*/
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL_, jwt, sql, ID } from "./support";
import {
  createOwnedClass, createOwnedReservation, cleanupOwnedClass, adoptUiCreatedClasses, memoryOwnershipStore, fileOwnershipStore, summarizeLedger, runScopedTitle, planManualCleanup, readManifest, orphanedClassIds,
  type OwnedCtx, type OwnershipStore,
} from "../e2e/fixtures/ownedClassCleanup";

type Fault = { method: string; urlPart: string };
function adminWithFaults(faults: Fault[] = []) {
  const rootFetch: typeof fetch = async (input, init) => {
    const url = String(input).replace("/rest/v1/", "/");
    const method = (init?.method ?? "GET").toUpperCase();
    if (faults.some((f) => f.method === method && url.includes(f.urlPart))) {
      return new Response(JSON.stringify({ message: "injected failure" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return fetch(url, init);
  };
  return createClient(URL_, jwt("service_role"), { global: { fetch: rootFetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

const CENTER = ID.centerPub, OTHER_CENTER = ID.centerPriv;
const OUR_PROFILE = ID.pA1, OTHER_PROFILE = ID.pB1;
const future = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const row = (title: string, center = CENTER, h = 30) => ({ center_id: center, title, start_time: future(h), end_time: future(h + 1), capacity: 5 });
const exists = (id: string) => sql(`select count(*) from classes where id='${id}'`) === "1";
const resCount = (classId: string) => Number(sql(`select count(*) from reservations where class_id='${classId}'`));
const addRes = (classId: string, profile = OUR_PROFILE, createdAt = "now()") =>
  sql(`insert into reservations(class_id, profile_id, status, created_at) values ('${classId}','${profile}','confirmed',${createdAt === "now()" ? "now()" : `'${createdAt}'`}) returning id`).split("\n")[0];
const ctxFor = (over: Partial<OwnedCtx> & { faults?: Fault[] } = {}): OwnedCtx & { store: ReturnType<typeof memoryOwnershipStore> } => ({
  admin: adminWithFaults(over.faults), store: memoryOwnershipStore(), runId: randomUUID(), testProfileIds: [OUR_PROFILE], ...over,
}) as OwnedCtx & { store: ReturnType<typeof memoryOwnershipStore> };

const created: string[] = [];
const tag = () => `Q01-${randomUUID().slice(0, 8)}`;
beforeEach(() => { orphanedClassIds.length = 0; });
afterAll(() => { // 이 파일이 만든 행만 id 로 정리(격리 DB 한정)
  if (created.length) { const ids = created.map((i) => `'${i}'`).join(","); sql(`delete from reservations where class_id in (${ids}); delete from admin_action_logs where class_id in (${ids}); delete from classes where id in (${ids})`); }
});
const track = async (c: OwnedCtx, title: string, center = CENTER) => { const r = await createOwnedClass(c, row(title, center)); created.push(r.id); return r; };
const foreignRow = (title: string, center = CENTER) => { const id = sql(`insert into classes(center_id,title,start_time,end_time,capacity) values ('${center}','${title}','${future(40)}','${future(41)}',3) returning id`).split("\n")[0]; created.push(id); return id; };

describe("Q01 생성: 다른 실행/증명 안 된 같은 제목 행 보존", () => {
  it("같은 센터·제목의 증명 안 된 행(+예약)이 있으면 지우지 않고 BLOCKED", async () => {
    const t = tag(); const fid = foreignRow(t); addRes(fid, OTHER_PROFILE);
    const c = ctxFor();
    await expect(createOwnedClass(c, row(t))).rejects.toThrow(/BLOCKED/);
    expect(exists(fid)).toBe(true); expect(resCount(fid)).toBe(1);
  });
  it("다른 실행이 만든(그 실행 manifest 에만 있는) 같은 제목 행도 보존 — runId 가 다르면 증명 실패", async () => {
    const t = tag(); const a = ctxFor(); const ra = await track(a, t);
    const b = ctxFor({ store: a.store }); // 같은 manifest 를 보지만 runId 가 다름
    await expect(createOwnedClass(b, row(t))).rejects.toThrow(/BLOCKED/);
    expect(exists(ra.id)).toBe(true);
  });
  it("조회 실패는 삭제 근거가 아니다(생성이 BLOCKED, 행 보존)", async () => {
    const t = tag(); const fid = foreignRow(t);
    await expect(createOwnedClass(ctxFor({ faults: [{ method: "GET", urlPart: "/classes?select=id%2Ccenter_id%2Ctitle%2Ccreated_at" }] }), row(t))).rejects.toThrow(/조회 실패/);
    expect(exists(fid)).toBe(true);
  });
  it("실행별 제목은 충돌 없이 공존하고, 같은 기본 제목의 다른 실행 행은 그대로", async () => {
    const base = tag(); const a = ctxFor(); const b = ctxFor();
    const ra = await track(a, runScopedTitle(base, a.runId)); const rb = await track(b, runScopedTitle(base, b.runId));
    expect(ra.title).not.toBe(rb.title);
    expect((await cleanupOwnedClass(a, ra.id)).status).toBe("deleted");
    expect(exists(ra.id)).toBe(false); expect(exists(rb.id)).toBe(true);
  });
});

describe("Q01 정리: 이 실행이 만든 것만", () => {
  it("자기 수업+테스트 계정 예약만 지우고, 다른 센터의 같은 제목·다른 수업은 그대로", async () => {
    const t = tag(); const c = ctxFor(); const mine = await track(c, t);
    const sameTitleOtherCenter = foreignRow(t, OTHER_CENTER); addRes(sameTitleOtherCenter, OTHER_PROFILE);
    const unrelated = foreignRow(tag());
    addRes(mine.id);
    const r = await cleanupOwnedClass(c, mine.id);
    expect(r.status).toBe("deleted"); expect(r.deletedReservationIds).toHaveLength(1);
    expect(exists(mine.id)).toBe(false);
    expect(exists(sameTitleOtherCenter)).toBe(true); expect(resCount(sameTitleOtherCenter)).toBe(1); expect(exists(unrelated)).toBe(true);
  });
  it("manifest 에 없는 id(다른 실행/사람 것)는 blocked — 삭제 안 함", async () => {
    const fid = foreignRow(tag());
    const r = await cleanupOwnedClass(ctxFor(), fid);
    expect(r.status).toBe("blocked"); expect(exists(fid)).toBe(true);
  });
  it("다른 프로필의 예약이 있으면 blocked — 수업·예약 모두 보존", async () => {
    const c = ctxFor(); const mine = await track(c, tag()); const rid = addRes(mine.id, OTHER_PROFILE);
    const r = await cleanupOwnedClass(c, mine.id);
    expect(r.status).toBe("blocked"); expect(r.reason).toContain(rid);
    expect(exists(mine.id)).toBe(true); expect(resCount(mine.id)).toBe(1);
  });
  it("수업 생성 이전에 만들어진 예약(다른 실행 소유 가능성)은 blocked", async () => {
    const c = ctxFor(); const mine = await track(c, tag()); addRes(mine.id, OUR_PROFILE, "2020-01-01T00:00:00Z");
    expect((await cleanupOwnedClass(c, mine.id)).status).toBe("blocked"); expect(resCount(mine.id)).toBe(1);
  });
  it("fixture 가 생성 응답으로 등록한 예약은 과거 시각이어도 정리되고, 등록 안 된 같은 조건 예약은 여전히 blocked", async () => {
    const c = ctxFor(); const mine = await track(c, tag());
    await createOwnedReservation(c, { classId: mine.id, profileId: OUR_PROFILE, createdAtIso: "2020-01-01T00:00:00Z" });
    expect((await cleanupOwnedClass(c, mine.id)).status).toBe("deleted"); expect(exists(mine.id)).toBe(false);
    const c2 = ctxFor(); const other = await track(c2, tag()); addRes(other.id, OUR_PROFILE, "2020-01-01T00:00:00Z");
    expect((await cleanupOwnedClass(c2, other.id)).status).toBe("blocked"); expect(resCount(other.id)).toBe(1);
  });
  it("이 실행이 만들지 않은 수업에는 소유 예약을 만들 수 없다(요청 단계에서 거부, 행 생성 없음)", async () => {
    const c = ctxFor(); const foreign = foreignRow(tag());
    await expect(createOwnedReservation(c, { classId: foreign, profileId: OUR_PROFILE })).rejects.toThrow(/이 실행이 만든 수업이 아님/);
    expect(resCount(foreign)).toBe(0);
  });
  it("임의의 기존 예약 id 를 위조 등록해도 삭제 대상이 되지 않는다(다른 수업의 예약·내용이 다른 기록은 무효)", async () => {
    const c = ctxFor(); const mine = await track(c, tag()); const otherCls = foreignRow(tag());
    const existing = addRes(otherCls, OTHER_PROFILE);                       // 남의 수업에 이미 있는 예약
    c.store.registerReservation({ reservationId: existing, classId: mine.id, profileId: OTHER_PROFILE, createdAt: "x", runId: c.runId });
    expect((await cleanupOwnedClass(c, mine.id)).status).toBe("deleted");   // 내 수업만 정리
    expect(resCount(otherCls)).toBe(1);                                      // 남의 예약은 그대로
    const c2 = ctxFor(); const mine2 = await track(c2, tag()); const real = addRes(mine2.id, OTHER_PROFILE);
    const actual = sql(`select created_at from reservations where id='${real}'`).replace(" ", "T");
    c2.store.registerReservation({ reservationId: real, classId: mine2.id, profileId: OTHER_PROFILE, createdAt: actual + "-forged", runId: c2.runId }); // 내용이 다른 기록
    expect((await cleanupOwnedClass(c2, mine2.id)).status).toBe("blocked"); expect(resCount(mine2.id)).toBe(1);
    const c3 = ctxFor(); const mine3 = await track(c3, tag()); const r3 = addRes(mine3.id, OTHER_PROFILE);
    c3.store.registerReservation({ reservationId: r3, classId: mine3.id, profileId: OTHER_PROFILE, createdAt: "x", runId: "다른-실행" }); // 다른 실행 기록
    expect((await cleanupOwnedClass(c3, mine3.id)).status).toBe("blocked");
  });
  it("관리자 조작 기록(admin_action_logs) 참조가 있으면 blocked — 감사 로그를 지우지 않는다", async () => {
    const c = ctxFor(); const mine = await track(c, tag()); const rid = addRes(mine.id);
    sql(`insert into admin_action_logs(center_id,reservation_id,action_type,reservation_type,reservation_source,admin_id,member_profile_id,class_id) values ('${CENTER}','${rid}','CANCEL_FREE','MEMBER','USER','c0000000-0000-0000-0000-00000000000c','${OUR_PROFILE}','${mine.id}')`);
    const r = await cleanupOwnedClass(c, mine.id);
    expect(r.status).toBe("blocked"); expect(exists(mine.id)).toBe(true); expect(resCount(mine.id)).toBe(1);
    expect(sql(`select count(*) from admin_action_logs where class_id='${mine.id}'`)).toBe("1");
    sql(`delete from admin_action_logs where class_id='${mine.id}'`);
  });
  it("DB 행의 제목/created_at 이 기록과 다르면(같은 행임을 증명 못 함) blocked", async () => {
    const c = ctxFor(); const mine = await track(c, tag());
    sql(`update classes set title = title || ' (수정됨)' where id='${mine.id}'`);
    expect((await cleanupOwnedClass(c, mine.id)).status).toBe("blocked"); expect(exists(mine.id)).toBe(true);
  });
  it("CASCADE 자식(class_allowed_products 등)은 수업과 함께 정리되고 상품 자체는 보존(#231/#234 상품 정리 회귀 방지)", async () => {
    const c = ctxFor(); const mine = await track(c, tag());
    sql(`insert into class_allowed_products(class_id, product_id) values ('${mine.id}','${ID.prodFree}')`);
    expect((await cleanupOwnedClass(c, mine.id)).status).toBe("deleted");
    expect(sql(`select count(*) from class_allowed_products where class_id='${mine.id}'`)).toBe("0");
    expect(sql(`select count(*) from products where id='${ID.prodFree}'`)).toBe("1");
  });
});

describe("Q01 실패 주입: 실패를 성공으로 오인하지 않는다", () => {
  const scenario = async (fault: Fault, setup?: (classId: string) => void) => {
    const c = ctxFor({ faults: [fault] }); const mine = await track(c, tag()); addRes(mine.id); setup?.(mine.id);
    return { c, mine, r: await cleanupOwnedClass(c, mine.id) };
  };
  it("수업 조회 실패 → failed, 아무것도 지우지 않음", async () => {
    const { mine, r } = await scenario({ method: "GET", urlPart: "/classes?select=id%2Ccenter_id%2Ctitle%2Ccreated_at&id=eq." });
    expect(r.status).toBe("failed"); expect(exists(mine.id)).toBe(true); expect(resCount(mine.id)).toBe(1);
  });
  it("예약 조회 실패 → failed, 아무것도 지우지 않음", async () => {
    const { mine, r } = await scenario({ method: "GET", urlPart: "/reservations?select=id%2Cprofile_id%2Ccreated_at" });
    expect(r.status).toBe("failed"); expect(exists(mine.id)).toBe(true); expect(resCount(mine.id)).toBe(1);
  });
  it("감사 로그 참조 확인 실패 → failed(확인 못 하면 삭제 안 함)", async () => {
    const { mine, r } = await scenario({ method: "HEAD", urlPart: "/admin_action_logs" });
    expect(r.status).toBe("failed"); expect(exists(mine.id)).toBe(true); expect(resCount(mine.id)).toBe(1);
  });
  it("예약 삭제 실패 → failed, 수업은 남음", async () => {
    const { mine, r } = await scenario({ method: "DELETE", urlPart: "/reservations?" });
    expect(r.status).toBe("failed"); expect(exists(mine.id)).toBe(true); expect(resCount(mine.id)).toBe(1);
  });
  it("수업 삭제 실패 → failed(예약은 이미 지워짐 — 트랜잭션 아님), 재시도하면 정리됨(멱등)", async () => {
    const { c, mine, r } = await scenario({ method: "DELETE", urlPart: "/classes?" });
    expect(r.status).toBe("failed"); expect(r.deletedReservationIds).toHaveLength(1);
    expect(exists(mine.id)).toBe(true); expect(resCount(mine.id)).toBe(0);
    const retry = await cleanupOwnedClass({ ...c, admin: adminWithFaults([]) }, mine.id);
    expect(retry.status).toBe("deleted"); expect(exists(mine.id)).toBe(false);
    expect(summarizeLedger(c.store.results).ok).toBe(true); // 이후 성공했으므로 미해결 아님
  });
  it("원장이 failed 로 끝나면 summarize 가 실행을 실패로 만든다", async () => {
    const { c } = await scenario({ method: "DELETE", urlPart: "/classes?" });
    const s = summarizeLedger(c.store.results);
    expect(s.ok).toBe(false); expect(s.message).toContain("failed");
  });
  it("중복 정리(이미 없음)는 already_gone — 오류 아님", async () => {
    const c = ctxFor(); const mine = await track(c, tag());
    expect((await cleanupOwnedClass(c, mine.id)).status).toBe("deleted");
    expect((await cleanupOwnedClass(c, mine.id)).status).toBe("already_gone");
    expect(summarizeLedger(c.store.results).ok).toBe(true);
  });
  it("cleanup 은 throw 하지 않는다 — 원장 기록이 실패해도 원래 테스트 실패를 가리지 않음", async () => {
    const c = ctxFor(); const mine = await track(c, tag());
    const bad: OwnershipStore = { ...c.store, recordResult: () => { throw new Error("disk full"); } };
    await expect(cleanupOwnedClass({ ...c, store: bad }, mine.id)).resolves.toMatchObject({ status: "deleted" });
  });
});

describe("Q01 추적: 생성 직후 실패·등록 실패·병렬·수동 정리", () => {
  it("생성 직후 테스트가 실패해도(cleanup 호출 없음) 파일 manifest 로 다른 프로세스가 후보를 찾아 안전하게 정리", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q01-")); const runId = randomUUID();
    const c1 = ctxFor({ runId, store: fileOwnershipStore(dir, runId) }); const mine = await track(c1, tag());
    const entries = readManifest(dir, runId); expect(entries.map((e) => e.classId)).toContain(mine.id);
    const c2 = ctxFor({ runId, store: fileOwnershipStore(dir, runId) }); // 새 프로세스
    const plan = await planManualCleanup(c2, entries);
    expect(plan[0]).toMatchObject({ exists: true, owned: true });
    expect((await cleanupOwnedClass(c2, mine.id)).status).toBe("deleted");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("manifest 등록이 실패하면 방금 만든 행만 되돌린다(다른 같은 제목 행은 그대로)", async () => {
    const t = tag(); const c = ctxFor(); const other = await track(ctxFor(), t + "-다른"); // 다른 실행의 무관한 행
    const failing: OwnershipStore = { ...c.store, register: () => { throw new Error("manifest 쓰기 실패"); } };
    const before = Number(sql(`select count(*) from classes where title='${t}'`));
    await expect(createOwnedClass({ ...c, store: failing }, row(t))).rejects.toThrow(/되돌림/);
    expect(Number(sql(`select count(*) from classes where title='${t}'`))).toBe(before);
    expect(exists(other.id)).toBe(true);
  });
  it("등록 실패 + 되돌리기 실패 → 추적되지 않는 id 를 에러와 orphan 목록에 남긴다", async () => {
    const t = tag(); const c = ctxFor({ faults: [{ method: "DELETE", urlPart: "/classes?" }] });
    const failing: OwnershipStore = { ...c.store, register: () => { throw new Error("manifest 쓰기 실패"); } };
    await expect(createOwnedClass({ ...c, store: failing }, row(t))).rejects.toThrow(/추적되지 않는 행 id=/);
    expect(orphanedClassIds).toHaveLength(1);
    created.push(orphanedClassIds[0]); expect(exists(orphanedClassIds[0])).toBe(true);
  });
  it("병렬 실행: 같은 기본 제목으로 동시에 만들고 정리해도 서로의 행을 고르거나 지우지 않는다", async () => {
    const base = tag(); const N = 6;
    const ctxs = Array.from({ length: N }, () => ctxFor());
    const made = await Promise.all(ctxs.map((c) => track(c, runScopedTitle(base, c.runId))));
    made.forEach((m, i) => addRes(m.id, OUR_PROFILE));
    const [first, ...rest] = ctxs;
    const r0 = await cleanupOwnedClass(first, made[0].id);
    expect(r0.status).toBe("deleted");
    rest.forEach((_, i) => { expect(exists(made[i + 1].id)).toBe(true); expect(resCount(made[i + 1].id)).toBe(1); });
    // 다른 실행의 id 를 내 ctx 로 정리하려 하면 blocked(내 manifest 에 없음)
    expect((await cleanupOwnedClass(first, made[1].id)).status).toBe("blocked");
    const all = await Promise.all(rest.map((c, i) => cleanupOwnedClass(c, made[i + 1].id)));
    expect(all.every((r) => r.status === "deleted")).toBe(true);
    made.forEach((m) => expect(exists(m.id)).toBe(false));
  });
});

describe("Q01 UI 가 만든 수업의 소유 등록(adopt) — 실행 UUID 제목 + 생성 응답 id 연결", () => {
  const START = () => new Date(Date.now() - 60_000).toISOString();
  const uiRow = (title: string, n = 1) => Array.from({ length: n }, () => foreignRow(title));
  it("제목에 이 실행 UUID 가 있고 응답 id 와 연결된 행만 등록되어 정리된다", async () => {
    const c = ctxFor(); const t = `${tag()}-${c.runId}`; const [id] = uiRow(t);
    expect(await adoptUiCreatedClasses(c, { createdIds: [id], centerId: CENTER, title: t }, START())).toEqual([id]);
    expect((await cleanupOwnedClass(c, id)).status).toBe("deleted"); expect(exists(id)).toBe(false);
  });
  it("제목에 이 실행 UUID 가 없으면 센터·제목·시각이 맞아도 등록을 거부하고 삭제도 blocked", async () => {
    const c = ctxFor(); const t = tag(); const [id] = uiRow(t);
    await expect(adoptUiCreatedClasses(c, { createdIds: [id], centerId: CENTER, title: t }, START())).rejects.toThrow(/UUID/);
    expect((await cleanupOwnedClass(c, id)).status).toBe("blocked"); expect(exists(id)).toBe(true);
  });
  it("다른 실행이 같은 센터·비슷한 시각에 같은 제목을 만들어도 응답 id 가 아닌 행은 등록·삭제되지 않는다", async () => {
    const c = ctxFor(); const t = `${tag()}-${c.runId}`; const [mine, theirs] = uiRow(t, 2); addRes(theirs, OTHER_PROFILE);
    await expect(adoptUiCreatedClasses(c, { createdIds: [mine], centerId: CENTER, title: t }, START())).rejects.toThrow(/응답에 없는 같은 센터·제목 행 1건/);
    expect((await cleanupOwnedClass(c, mine)).status).toBe("deleted");       // 응답 id 쪽 검증된 행은 등록돼 정리 가능
    expect((await cleanupOwnedClass(c, theirs)).status).toBe("blocked");     // 남의 행은 소유 증명이 없어 거부
    expect(exists(theirs)).toBe(true); expect(resCount(theirs)).toBe(1);
  });
  it("반복 생성은 응답이 돌려준 전체 id 를 추적하고, 응답에 없는 행은 등록하지 않는다", async () => {
    const c = ctxFor(); const t = `${tag()}-${c.runId}`; const ids = uiRow(t, 4);
    const resp = ids.slice(0, 3);
    await expect(adoptUiCreatedClasses(c, { createdIds: resp, centerId: CENTER, title: t }, START())).rejects.toThrow(/1건/);
    for (const id of resp) expect((await cleanupOwnedClass(c, id)).status).toBe("deleted");
    expect((await cleanupOwnedClass(c, ids[3])).status).toBe("blocked"); expect(exists(ids[3])).toBe(true);
  });
  it("응답 id 가 비었거나 DB 행과 맞지 않거나 실행 시작 이전 생성이면 등록하지 않는다", async () => {
    const c = ctxFor(); const t = `${tag()}-${c.runId}`; const [id] = uiRow(t);
    await expect(adoptUiCreatedClasses(c, { createdIds: [], centerId: CENTER, title: t }, START())).rejects.toThrow(/id 가 없음/);
    await expect(adoptUiCreatedClasses(c, { createdIds: [randomUUID()], centerId: CENTER, title: t }, START())).rejects.toThrow(/DB 행이 없음/);
    await expect(adoptUiCreatedClasses(c, { createdIds: [id], centerId: OTHER_CENTER, title: t }, START())).rejects.toThrow(/DB 행이 없음/);
    await expect(adoptUiCreatedClasses(c, { createdIds: [id], centerId: CENTER, title: t }, new Date(Date.now() + 3600_000).toISOString())).rejects.toThrow(/먼저 생성/);
    expect((await cleanupOwnedClass(c, id)).status).toBe("blocked"); expect(exists(id)).toBe(true);
  });
  it("조회 실패는 등록하지 않는다", async () => {
    const c = ctxFor({ faults: [{ method: "GET", urlPart: "/classes?select=id%2C%20center_id%2C%20title%2C%20created_at" }, { method: "GET", urlPart: "/classes?select=id%2Ccenter_id%2Ctitle%2Ccreated_at" }] });
    const t = `${tag()}-${c.runId}`; const [id] = uiRow(t);
    await expect(adoptUiCreatedClasses(c, { createdIds: [id], centerId: CENTER, title: t }, START())).rejects.toThrow(/조회 실패/);
    expect(c.store.get(id)).toBeUndefined();
  });
});
