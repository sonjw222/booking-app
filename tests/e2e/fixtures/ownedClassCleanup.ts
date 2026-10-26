/*
  E2E 수업 생성·정리의 소유권 안전 코어 (Q01).

  이전 방식(deleteExistingClassesByTitle)은 "같은 센터 + 같은 제목"이면 누구 것이든 그 수업과
  예약을 전부 지웠다. 제목·센터·시간대는 소유 증거가 아니다.

  규칙
  1. manifest(실행별 파일)는 "삭제 후보 목록"일 뿐 삭제 권한이 아니다. 삭제 직전에 매번
     manifest 항목(생성 성공 기록·runId·센터·제목·DB created_at)을 DB의 실제 행과 대조하고,
     참조(예약·감사 로그)를 조회해 이 실행의 테스트 계정 것임이 증명될 때만 지운다.
  2. 조회 실패·소유권 불명·다른 실행/프로필의 예약·감사 로그 참조가 하나라도 있으면 삭제하지 않고
     blocked/failed 로 남긴다. 조회 실패는 삭제 근거가 아니다.
  3. 생성: 같은 센터·제목의 기존 행이 이 실행의 manifest 항목으로 증명되면 정리 후 재사용하고,
     그 밖의 행이 있으면 지우지 않고 BLOCKED(throw). 실행별 제목(runScopedTitle)을 쓰면 충돌 자체가 없다.
  4. 생성 직후 manifest 에 등록한다(그 뒤 테스트가 바로 실패해도 추적). 등록 실패 시 방금 만든(id 를
     아는) 행만 조건부로 지우고, 그것도 실패하면 orphan 으로 남겨 에러 메시지에 id 를 싣는다.
  5. cleanup 은 throw 하지 않는다(원래 테스트 실패가 teardown 오류에 가려지지 않도록). 결과는
     deleted/already_gone/blocked/failed 로 원장에 남고, 전역 teardown 이 blocked/failed 를 모아 실행을 실패시킨다.
  6. PostgREST 로는 예약+수업 삭제를 한 트랜잭션으로 묶을 수 없다(새 RPC 는 운영 SQL 변경이라 만들지 않음).
     예약 삭제 후 수업 삭제가 실패하면 failed 로 기록하고 manifest 기반 수동 정리로만 처리한다.
*/
import fs from "node:fs";
import path from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AdminLike = { from: (table: string) => any };

export type OwnedClassEntry = { classId: string; centerId: string; title: string; runId: string; rowCreatedAt: string; registeredAt: string };
export type CleanupStatus = "deleted" | "already_gone" | "blocked" | "failed";
export type CleanupResult = { classId: string; status: CleanupStatus; reason?: string; deletedReservationIds: string[] };

export interface OwnershipStore {
  register(entry: OwnedClassEntry): void;
  get(classId: string): OwnedClassEntry | undefined;
  recordResult(r: CleanupResult): void;
}

export function memoryOwnershipStore(): OwnershipStore & { results: CleanupResult[]; entries: Map<string, OwnedClassEntry> } {
  const entries = new Map<string, OwnedClassEntry>();
  const results: CleanupResult[] = [];
  return { results, entries, register: (e) => { entries.set(e.classId, e); }, get: (id) => entries.get(id), recordResult: (r) => { results.push(r); } };
}

/** JSON Lines — 한 줄씩 append 라 워커가 여러 개여도 줄이 섞이지 않는다. */
export function fileOwnershipStore(dir: string, runId: string): OwnershipStore {
  const manifest = path.join(dir, `owned-classes-${runId}.jsonl`);
  const ledger = path.join(dir, `owned-classes-${runId}.results.jsonl`);
  const read = <T,>(f: string): T[] => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
  return {
    register(e) { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(manifest, JSON.stringify(e) + "\n"); },
    get: (id) => read<OwnedClassEntry>(manifest).find((e) => e.classId === id),
    recordResult(r) { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(ledger, JSON.stringify(r) + "\n"); },
  };
}
export const readManifest = (dir: string, runId: string): OwnedClassEntry[] => {
  const f = path.join(dir, `owned-classes-${runId}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as OwnedClassEntry) : [];
};
export const readLedger = (dir: string, runId: string): CleanupResult[] => {
  const f = path.join(dir, `owned-classes-${runId}.results.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CleanupResult) : [];
};

export type OwnedCtx = {
  admin: AdminLike;
  store: OwnershipStore;
  runId: string;
  /** 이 실행이 쓰는 테스트 계정의 profile id — 이 프로필의 예약만 "우리 것"으로 인정. 비어 있으면 예약이 하나라도 있으면 blocked. */
  testProfileIds: string[];
  /** 시계 오차 허용(ms). */
  skewMs?: number;
};

const SKEW = 5 * 60 * 1000;
const msg = (what: string, e: { message: string }) => `${what}: ${e.message}`;
/** 등록 실패 + 되돌리기 실패로 추적되지 않는 행 — 프로세스 안에서 조회·보고용. */
export const orphanedClassIds: string[] = [];

/** 실행별 제목 — 같은 기본 제목이어도 실행끼리 서로 다른 행이 된다. */
export const runScopedTitle = (base: string, runId: string): string => `${base} [${runId.slice(0, 6)}]`;

function proveOwned(ctx: OwnedCtx, entry: OwnedClassEntry | undefined, row: { id: string; center_id: string; title: string; created_at?: string }): string | null {
  if (!entry) return "이 실행의 생성 기록(manifest)이 없음";
  if (entry.runId !== ctx.runId) return `다른 실행(${entry.runId})의 기록`;
  if (entry.classId !== row.id) return "기록의 id 와 DB 행 id 불일치";
  if (row.center_id !== entry.centerId) return "DB 행의 센터가 기록과 다름";
  if (row.title !== entry.title) return "DB 행의 제목이 기록과 다름";
  if (!row.created_at || row.created_at !== entry.rowCreatedAt) return "DB 행의 created_at 이 생성 시 기록과 다름(같은 행임을 증명 못 함)";
  return null;
}

async function ensureNoForeignSameTitle(ctx: OwnedCtx, centerId: string, title: string): Promise<void> {
  const { data, error } = await ctx.admin.from("classes").select("id, center_id, title, created_at").eq("center_id", centerId).eq("title", title);
  if (error) throw new Error(`BLOCKED: 같은 제목 수업 조회 실패(조회 실패는 삭제 근거가 아님) — ${error.message}`);
  const rows = (data ?? []) as { id: string; center_id: string; title: string; created_at: string }[];
  if (!rows.length) return;
  const foreign = rows.filter((r) => proveOwned(ctx, ctx.store.get(r.id), r) !== null);
  if (foreign.length) {
    throw new Error(
      `BLOCKED: 센터 ${centerId} 에 제목 "${title}" 수업 ${foreign.length}건이 이미 있고 이 실행(${ctx.runId})이 만든 것으로 증명되지 않음 — 지우지 않음. ` +
      `실행별 제목(runScopedTitle)을 쓰거나, 이전 실행 잔여라면 사람이 확인 후 수동 정리 (ids: ${foreign.map((f) => f.id).join(",")})`
    );
  }
  for (const r of rows) {
    const res = await cleanupOwnedClass(ctx, r.id);
    if (res.status === "blocked" || res.status === "failed") throw new Error(`BLOCKED: 이 실행의 같은 제목 수업 ${r.id} 정리 불가 — ${res.reason}`);
  }
}

export async function createOwnedClass(
  ctx: OwnedCtx,
  row: Record<string, unknown> & { center_id: string; title: string }
): Promise<{ id: string; startTime: string; title: string }> {
  await ensureNoForeignSameTitle(ctx, row.center_id, row.title);
  const { data, error } = await ctx.admin.from("classes").insert(row).select("id, start_time, created_at").single();
  if (error || !data) throw new Error(`E2E 테스트 수업 생성 실패: ${error?.message ?? "no data"}`);
  try {
    ctx.store.register({ classId: data.id, centerId: row.center_id, title: row.title, runId: ctx.runId, rowCreatedAt: data.created_at, registeredAt: new Date().toISOString() });
  } catch (e) {
    // 방금 만든(id 를 아는) 행만, 만든 행임을 확인하는 조건(id+센터+제목+created_at)으로 되돌린다.
    const { error: undoErr } = await ctx.admin.from("classes").delete().eq("id", data.id).eq("center_id", row.center_id).eq("title", row.title).eq("created_at", data.created_at);
    if (undoErr) {
      orphanedClassIds.push(data.id);
      throw new Error(`소유 manifest 기록 실패 + 되돌리기도 실패 — 추적되지 않는 행 id=${data.id} (사람이 확인): ${(e as Error).message} / ${undoErr.message}`);
    }
    throw new Error(`소유 manifest 기록 실패 — 방금 만든 수업(${data.id})을 되돌림: ${(e as Error).message}`);
  }
  return { id: data.id, startTime: data.start_time, title: row.title };
}

/** raw insert 로 수업을 만든 스펙용 — insert 결과(id, created_at)로 생성 직후 등록한다. */
export function registerOwnedClass(ctx: OwnedCtx, created: { id: string; created_at: string }, centerId: string, title: string): void {
  ctx.store.register({ classId: created.id, centerId, title, runId: ctx.runId, rowCreatedAt: created.created_at, registeredAt: new Date().toISOString() });
}

/** 절대 throw 하지 않는다 — 결과를 반환하고 원장에 남긴다. */
export async function cleanupOwnedClass(ctx: OwnedCtx, classId: string): Promise<CleanupResult> {
  const done = (status: CleanupStatus, reason?: string, deletedReservationIds: string[] = []): CleanupResult => {
    const r: CleanupResult = { classId, status, reason, deletedReservationIds };
    try { ctx.store.recordResult(r); } catch { /* 원장 기록 실패는 반환값으로 여전히 전달된다 */ }
    return r;
  };
  try {
    const entry = ctx.store.get(classId);
    if (!entry) return done("blocked", "이 실행의 생성 기록(manifest)이 없음 — 소유를 증명할 수 없어 삭제하지 않음");

    const { data: cls, error: clsErr } = await ctx.admin.from("classes").select("id, center_id, title, created_at").eq("id", classId).maybeSingle();
    if (clsErr) return done("failed", msg("수업 조회 실패(삭제하지 않음)", clsErr));
    if (!cls) return done("already_gone");
    const why = proveOwned(ctx, entry, cls);
    if (why) return done("blocked", `소유 증명 실패: ${why}`);

    const { data: resv, error: resvErr } = await ctx.admin.from("reservations").select("id, profile_id, created_at").eq("class_id", classId);
    if (resvErr) return done("failed", msg("예약 조회 실패(삭제하지 않음)", resvErr));
    const reservations = (resv ?? []) as { id: string; profile_id: string; created_at: string }[];
    const skew = ctx.skewMs ?? SKEW;
    const since = Date.parse(entry.registeredAt) - skew;
    const foreign = reservations.filter((r) => !ctx.testProfileIds.includes(r.profile_id) || !(Date.parse(r.created_at) >= since));
    if (foreign.length) return done("blocked", `이 실행의 테스트 계정이 만든 예약이 아님(다른 프로필이거나 수업 생성 이전) ${foreign.length}건: ${foreign.map((f) => f.id).join(",")}`);

    // 감사 로그(admin_action_logs.class_id / reservation_id)는 FK NO ACTION — 사람의 조작 기록이므로 지우지 않고,
    // 확인하지 못해도 지우지 않는다. (classes 의 나머지 FK 는 CASCADE: class_allowed_products/class_trainers/schedule_memos)
    const resIds = reservations.map((r) => r.id);
    const checks: Array<[string, any]> = [["admin_action_logs.class_id", ctx.admin.from("admin_action_logs").select("*", { count: "exact", head: true }).eq("class_id", classId)]];
    if (resIds.length) checks.push(["admin_action_logs.reservation_id", ctx.admin.from("admin_action_logs").select("*", { count: "exact", head: true }).in("reservation_id", resIds)]);
    for (const [label, q] of checks) {
      const { count, error } = await q;
      if (error) return done("failed", msg(`${label} 참조 확인 실패(확인 못 한 참조가 있으면 삭제하지 않음)`, error));
      if ((count ?? 0) > 0) return done("blocked", `${label} 참조 ${count}건(관리자 조작 기록) — 삭제하지 않음`);
    }

    const deletedReservationIds: string[] = [];
    if (resIds.length) {
      const { error } = await ctx.admin.from("reservations").delete().in("id", resIds).eq("class_id", classId).in("profile_id", ctx.testProfileIds);
      if (error) return done("failed", msg("예약 삭제 실패 — 수업은 그대로 둠(예약 일부가 지워졌을 수 있음)", error));
      deletedReservationIds.push(...resIds);
    }
    const { error: delErr } = await ctx.admin.from("classes").delete().eq("id", classId).eq("center_id", entry.centerId).eq("title", entry.title).eq("created_at", entry.rowCreatedAt);
    if (delErr) return done("failed", msg("수업 삭제 실패 — 예약은 이미 지워짐(트랜잭션 아님), manifest 기반 수동 정리 필요", delErr), deletedReservationIds);
    return done("deleted", undefined, deletedReservationIds);
  } catch (e) {
    return done("failed", `예상치 못한 오류: ${(e as Error).message}`);
  }
}

/** 실행 종료 시 호출 — 해결되지 않은 blocked/failed 가 있으면 ok=false. */
export function summarizeLedger(results: CleanupResult[]): { ok: boolean; message: string } {
  const unresolved = results.filter((b) => (b.status === "blocked" || b.status === "failed") && !results.some((r) => r.classId === b.classId && (r.status === "deleted" || r.status === "already_gone")));
  if (!unresolved.length) return { ok: true, message: `수업 정리 ${results.length}건: 미해결 0` };
  return { ok: false, message: unresolved.map((u) => `${u.classId}: ${u.status} — ${u.reason}`).join("\n") };
}

/** 수동 정리 계획(읽기 전용): manifest 의 각 항목이 아직 DB 에 있는지·소유 증명이 되는지 보고만 한다. 삭제는 cleanupOwnedClass 로만. */
export async function planManualCleanup(ctx: OwnedCtx, entries: OwnedClassEntry[]): Promise<Array<{ classId: string; exists: boolean; owned: boolean; note: string }>> {
  const out: Array<{ classId: string; exists: boolean; owned: boolean; note: string }> = [];
  for (const e of entries) {
    const { data, error } = await ctx.admin.from("classes").select("id, center_id, title, created_at").eq("id", e.classId).maybeSingle();
    if (error) { out.push({ classId: e.classId, exists: false, owned: false, note: `조회 실패: ${error.message}` }); continue; }
    if (!data) { out.push({ classId: e.classId, exists: false, owned: false, note: "이미 없음" }); continue; }
    const why = proveOwned({ ...ctx, runId: e.runId }, e, data);
    out.push({ classId: e.classId, exists: true, owned: why === null, note: why ?? "소유 증명됨 — 수동 정리 대상" });
  }
  return out;
}
