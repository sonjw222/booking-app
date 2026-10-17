// @vitest-environment node
/* TypeScript NICEPAY 라이프사이클 ↔ 실제 PostgreSQL 16(격리, 로컬 전용) — RPC 이름/인자, 상태 전이, 행 잠금, 취소 기록 가드가 서버 코드와 실제로 맞물리는지 검증한다.
   REAL_PG_URL(loopback)이 없으면 건너뛴다(기본 CI/로컬 단위 테스트에는 영향 없음). 실행: docker run -d -e POSTGRES_PASSWORD=x -p 127.0.0.1:55432:5432 postgres:16-alpine; npm i --no-save pg;
   REAL_PG_URL=postgres://postgres:x@127.0.0.1:55432/postgres npx vitest run tests/unit/nicepay.realpg.lifecycle.test.ts   (PG 호출/Supabase/돈 없음 — 가짜 PG만) */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nicepayDbDeps, type RpcLike } from "../../lib/payments/server/nicepay/db";
import { handleNicepayRestAuthReturn, type RestDeps } from "../../lib/payments/server/nicepay/restLifecycle";
import { handleNicepayRefund, restRefundPort, type NicepayRefundDeps } from "../../lib/payments/server/nicepay/refund";
import type { RefundCtx } from "../../lib/payments/server/lifecycle";
import { CREDS, FakePg } from "./helpers/nicepayFakes";

const URL_ = process.env.REAL_PG_URL;
const enabled = !!URL_ && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(URL_).hostname);
type Client = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> };

describe.skipIf(!enabled)("NICEPAY TS 라이프사이클 ↔ 실제 PostgreSQL", () => {
  let admin: Client, c: Client, dbName = "", W: Record<string, string> & { baseWorldSql(o: object): string; coreInstallSql(o: object): string }, ids: { id(k: number, n: number): string; C1: string; P1: string; PROD: string; AUTH: string };
  const mod = "pg";
  beforeAll(async () => {
    const pg = (await import(/* @vite-ignore */ mod)).default as { Client: new (o: { connectionString: string }) => Client & { connect(): Promise<void> } };
    admin = new pg.Client({ connectionString: URL_! }) as Client & { connect(): Promise<void> }; await (admin as unknown as { connect(): Promise<void> }).connect();
    dbName = `qa_nicepay_ts_${Math.random().toString(36).slice(2, 9)}`; await admin.query(`create database ${dbName}`);
    const u = new URL(URL_!); u.pathname = "/" + dbName;
    c = new pg.Client({ connectionString: u.toString() }) as Client & { connect(): Promise<void> }; await (c as unknown as { connect(): Promise<void> }).connect();
    W = (await import("../sql/helpers/nicepayWorld.mjs")) as unknown as typeof W; ids = W as unknown as typeof ids;
    await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if; end $$;`);
    await c.query(W.baseWorldSql({}).replace("create role anon; create role authenticated; create role service_role bypassrls;", ""));
    await c.query(W.coreInstallSql({}));
    for (const f of ["refundFix", "support", "serverFix", "amountFix", "roleGuardFix"]) await c.query(W[f]);
  }, 120_000);
  afterAll(async () => { try { await c?.end(); } catch { /* 정리 */ } try { await admin?.query(`drop database if exists ${dbName} with (force)`); await admin?.end(); } catch { /* 정리 */ } });

  // supabase-js rpc 와 같은 모양: 이름 + 인자 객체 → 이름 붙은 인자 호출(함수 정의의 파라미터 이름과 어긋나면 여기서 실패한다)
  const rpc: RpcLike = { rpc: async (fn, args) => {
    const keys = Object.keys(args);
    try { const r = await c.query(`select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k])); return { data: r.rows[0].r ?? null, error: null }; }
    catch (e) { return { data: null, error: { message: (e as Error).message } }; }
  } };
  const db = () => nicepayDbDeps(rpc);
  const logs: string[] = [];
  const depsFor = (pg: FakePg): RestDeps => ({ creds: CREDS, fetchImpl: pg.fetch, now: () => new Date("2026-10-17T03:00:00Z"), gateAllows: async () => true, log: (l, e, f) => { logs.push(`${l} ${e} ${JSON.stringify(f)}`); }, ...db() });
  const newOrder = async (amount = 12000) => {
    const oid = ids.id(5, Math.floor(Math.random() * 1e9));
    await c.query(`insert into orders(id, profile_id, center_id, product_id, product_name, amount, status, payment_provider) values ($1,$2,$3,$4,'p',$5,'pending','nicepay')`, [oid, ids.P1, ids.C1, ids.PROD, amount]);
    return oid;
  };
  const one = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];
  const n = async (sql: string, p: unknown[] = []) => Number((await one(sql, p)).n);

  it("정상 구매: 인증 → 서버 승인 → 승인 기록 → 확정 → 수강권/결제 1건, 로그에 키·토큰 없음", async () => {
    const pg = new FakePg(), oid = await newOrder();
    const r = await handleNicepayRestAuthReturn(pg.authorize(oid, 12000), depsFor(pg));
    expect(r.status).toBe(200);
    expect(await one(`select status, pg_tid is not null as has_tid from orders where id=$1`, [oid])).toEqual({ status: "done", has_tid: true });
    expect(await n(`select count(*)::int n from payments where order_id=$1 and sale_type='new' and payment_provider='nicepay' and total_amount=12000`, [oid])).toBe(1);
    expect(await n(`select count(*)::int n from nicepay_pg_approvals where order_id=$1`, [oid])).toBe(1);
    expect(logs.join("\n")).not.toMatch(/test_secret_key_not_real|AT_UT/);
  });
  it("같은 주문 동시 인증 결과 2건(중복 클릭/재전송): 승인 호출 1번, 수강권 1개 — 행 잠금과 선점이 실제로 직렬화한다", async () => {
    const pg = new FakePg(), oid = await newOrder();
    const [a, b] = await Promise.all([handleNicepayRestAuthReturn(pg.authorize(oid, 12000), depsFor(pg)), handleNicepayRestAuthReturn(pg.authorize(oid, 12000), depsFor(pg))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]); expect(pg.count("approve")).toBe(1);
    expect(await n(`select count(*)::int n from memberships m join payments p on p.membership_id=m.id where p.order_id=$1`, [oid])).toBe(1);
  });
  it("승인 응답 유실(PG는 승인) → 망취소 전에 조회로 paid 확인 → 취소 없이 실제 DB가 구매 확정(done, 결제 1건, 승인 기록)", async () => {
    const pg = new FakePg(), oid = await newOrder(); pg.faults.approve = "timeout_after";
    expect((await handleNicepayRestAuthReturn(pg.authorize(oid, 12000), depsFor(pg))).status).toBe(200);
    expect(pg.count("lookup")).toBe(1); expect(pg.count("netcancel")).toBe(0);
    expect((await one(`select status from orders where id=$1`, [oid])).status).toBe("done");
    expect(await n(`select count(*)::int n from payments where order_id=$1`, [oid])).toBe(1);
    expect(await n(`select count(*)::int n from nicepay_pg_approvals where order_id=$1`, [oid])).toBe(1);
  });
  it("승인 요청이 PG에 닿기 전 실패(돈 안 움직임) → 조회로 미승인 확인 → 망취소 없이 실제 DB release 허용(승인 기록 없음) → pending 복귀, 감사 기록 남음", async () => {
    const pg = new FakePg(), oid = await newOrder(); pg.faults.approve = "timeout_before";   // 돈이 움직이지 않음
    expect((await handleNicepayRestAuthReturn(pg.authorize(oid, 12000), depsFor(pg))).body.code).toBe("approve_unknown");
    expect(pg.count("netcancel")).toBe(0);
    expect((await one(`select status from orders where id=$1`, [oid])).status).toBe("pending");
    expect(await n(`select count(*)::int n from payments where order_id=$1`, [oid])).toBe(0);
    expect(await n(`select count(*)::int n from nicepay_review_actions where order_id=$1 and action='release'`, [oid])).toBe(1);
  });
  it("승인 응답 서명 위조 → 망취소 + 복귀 / 망취소도 실패하면 approving 유지 + 운영자 확인 표시(DB가 재선점·성공 처리를 막는다)", async () => {
    const pg = new FakePg(), oid = await newOrder(); pg.faults.approve = "bad_signature";
    expect((await handleNicepayRestAuthReturn(pg.authorize(oid, 12000), depsFor(pg))).body.code).toBe("approve_mismatch");
    expect((await one(`select status from orders where id=$1`, [oid])).status).toBe("pending");
    const pg2 = new FakePg(), oid2 = await newOrder(); pg2.faults = { approve: "timeout_after", lookup: "fail", netcancel: "fail" };
    expect((await handleNicepayRestAuthReturn(pg2.authorize(oid2, 12000), depsFor(pg2))).body.code).toBe("compensation_failed");
    expect(await one(`select status, pg_review_reason, pg_review_at is not null as flagged from orders where id=$1`, [oid2])).toEqual({ status: "approving", pg_review_reason: "netcancel_failed", flagged: true });
    pg2.faults = {}; expect((await handleNicepayRestAuthReturn(pg2.authorize(oid2, 12000), depsFor(pg2))).status).toBe(409);
  });
  it("금액 위변조(인증 amount ≠ DB)·잘못된 주문번호는 승인 호출 없이 거부, 주문 상태 불변", async () => {
    const pg = new FakePg(), oid = await newOrder(); const a = pg.authorize(oid, 12000);
    const r = await handleNicepayRestAuthReturn({ ...a, amount: "1200" }, depsFor(pg)); expect(r.status).toBe(400);
    expect((await handleNicepayRestAuthReturn(pg.authorize("ffffffff-ffff-4fff-8fff-ffffffffffff", 12000), depsFor(pg))).status).toBe(404);
    expect(pg.count("approve")).toBe(0); expect((await one(`select status from orders where id=$1`, [oid])).status).toBe("pending");
  });

  async function purchased(amount = 12000) {
    const pg = new FakePg(), oid = await newOrder(amount);
    expect((await handleNicepayRestAuthReturn(pg.authorize(oid, amount), depsFor(pg))).status).toBe(200);
    const mid = String((await one(`select membership_id m from payments where order_id=$1`, [oid])).m);
    return { pg, oid, mid };
  }
  const refundDeps = (pg: FakePg, uid: string): NicepayRefundDeps => ({
    port: restRefundPort(CREDS, pg.fetch, () => new Date("2026-10-17T03:00:00Z"), () => {}),
    refundBegin: async (m, u) => { const r = await one(`select pg_refund_begin($1,$2) r`, [m, u]); return r.r as { state: "locked" | "resumed" | "blocked" | "refunded"; reason?: string }; },
    refundRelease: async (m, u) => { try { await c.query(`select pg_refund_release($1,$2)`, [m, u]); return { data: null, error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } },
    recordPgCancel: db().recordPgCancel,
    dbRefund: async (m, u, o) => { try { const r = await one(`select refund_membership_server($1,$2,$3,$4) r`, [m, u, o.allowPg, o.skipTimeCheck]); return { data: r.r as Record<string, unknown>, error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } },
    log: () => {},
  });
  const ctxOf = async (mid: string): Promise<RefundCtx> => (await one(`select pg_refund_context($1,$2) r`, [mid, ids.AUTH])).r as RefundCtx;

  it("환불: PG 취소 확인 → 취소 기록 → 내부 환불. 환불 금액 = 원거래 금액 = 취소 기록 금액(후속 수기 결제가 있어도)", async () => {
    const { pg, oid, mid } = await purchased(12000);
    await c.query(`insert into payments(center_id, profile_id, membership_id, sale_type, total_amount, paid_at, status) values ($1,$2,$3,'new',5000,now() + interval '1 minute','paid')`, [ids.C1, ids.P1, mid]);   // 후속 수기 결제(최신 행)
    const ctx = await ctxOf(mid); expect(ctx).toMatchObject({ provider: "nicepay", amount: 12000, orderId: oid });
    const r = await handleNicepayRefund(ctx, ids.AUTH, refundDeps(pg, ids.AUTH));
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ refunded: true, amount: 12000 });
    expect((await one(`select status from memberships where id=$1`, [mid])).status).toBe("refunded");
    expect(await n(`select count(*)::int n from payments where membership_id=$1 and sale_type='refund' and total_amount=-12000`, [mid])).toBe(1);
    expect(await n(`select count(*)::int n from nicepay_pg_cancels where order_id=$1 and cancel_amount=12000`, [oid])).toBe(1);
  });
  it("DB 가드 증명: 취소 기록 없이 서버 경로로 NICEPAY 환불을 시도하면 실제 DB가 거부한다", async () => {
    const { mid } = await purchased(8000);
    await one(`select pg_refund_begin($1,$2) r`, [mid, ids.AUTH]);
    await expect(c.query(`select refund_membership_server($1,$2,true,true)`, [mid, ids.AUTH])).rejects.toThrow(/PG 승인 취소가 확인된 뒤에만/);
    expect((await one(`select status from memberships where id=$1`, [mid])).status).toBe("active");
  });
  it("환불 중 PG 취소 결과 불명(타임아웃 + 조회 실패) → 내부 환불 없음, 환불 표시 유지 → 복구 후 같은 요청으로 이어서 완료(중복 취소 기록 없음)", async () => {
    const { pg, oid, mid } = await purchased(9000);
    pg.faults = { cancel: "timeout_after", lookup: "fail" };
    const r = await handleNicepayRefund(await ctxOf(mid), ids.AUTH, refundDeps(pg, ids.AUTH));
    expect(r.body.code).toBe("pg_cancel_unknown");
    expect(await one(`select status, pg_refund_started_at is not null as marked from memberships where id=$1`, [mid])).toEqual({ status: "active", marked: true });
    pg.faults = {};
    expect((await handleNicepayRefund(await ctxOf(mid), ids.AUTH, refundDeps(pg, ids.AUTH))).status).toBe(200);
    expect(await n(`select count(*)::int n from nicepay_pg_cancels where order_id=$1`, [oid])).toBe(1);
    expect(await n(`select count(*)::int n from payments where membership_id=$1 and sale_type='refund'`, [mid])).toBe(1);
  });
  it("동시 환불 2건: 환불 행 1개, PG 취소 거래 1건", async () => {
    const { pg, mid } = await purchased(7000);
    const ctx = await ctxOf(mid);
    const [a, b] = await Promise.all([handleNicepayRefund(ctx, ids.AUTH, refundDeps(pg, ids.AUTH)), handleNicepayRefund(ctx, ids.AUTH, refundDeps(pg, ids.AUTH))]);
    expect([a.status, b.status]).toContain(200);
    expect(await n(`select count(*)::int n from payments where membership_id=$1 and sale_type='refund'`, [mid])).toBe(1);
    expect([...pg.txs.values()].filter((t) => t.status === "cancelled")).toHaveLength(1);
  });
});
