/* F18 — 미수금 초과 회수. 격리 PostgreSQL(저장소 마이그레이션) + 실제 JWT(센터 오너 M / 권한 없는 직원 S / 다른 센터 오너 T / 일반 회원 A / 익명).
   1) 수정 전(저장소의 옛 정의): 700원 잔액에 701원을 받아 수금 합이 1001원이 되는 QA 결함을 재현한다.
   2) fix_collect_unpaid_overcollect_20261023.sql 적용 후: 초과·음수·소수·0·NULL 거절, 정상 부분/정확 완납 허용, 완납 후 재요청 거절, 동시 회수 합계 보존, 권한·센터 격리, 실패 시 행 불변. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientFor, ensureExtraStaff, ID, sql, U, U2 } from "./support";

const FIX = path.resolve(__dirname, "../../fix_collect_unpaid_overcollect_20261023.sql");
const ROLLBACK = path.resolve(__dirname, "../../rollback_fix_collect_unpaid_overcollect_20261023.sql");
const apply = (file: string) => execFileSync("docker", ["exec", "-i", "qa-rls-pg", "psql", "-U", "postgres", "-d", "qa", "-v", "ON_ERROR_STOP=1"], { input: fs.readFileSync(file, "utf8"), encoding: "utf8" });
const owner = () => clientFor(U.M);
const collect = (c: ReturnType<typeof clientFor>, id: string, a: { card?: number | null; cash?: number | null; transfer?: number | null; point?: number | null }) =>
  c.rpc("collect_unpaid_payment", { p_original_payment_id: id, p_card_amount: a.card ?? 0, p_cash_amount: a.cash ?? 0, p_transfer_amount: a.transfer ?? 0, p_point_amount: a.point ?? 0, p_paid_at: new Date().toISOString(), p_memo: "qa" });
const newUnpaid = (unpaid: number, center = ID.centerPub) => sql(`insert into payments(profile_id,center_id,sale_type,total_amount,unpaid_amount,status) values ('${ID.pB1}','${center}','new',${5000 - unpaid},${unpaid},'paid') returning id`).split("\n")[0];
const unpaidOf = (id: string) => Number(sql(`select unpaid_amount from payments where id='${id}'`));
const collectedOf = (id: string) => Number(sql(`select coalesce(sum(total_amount),0) from payments where linked_unpaid_payment_id='${id}'`));
const rowsOf = (id: string) => Number(sql(`select count(*) from payments where linked_unpaid_payment_id='${id}'`));

describe("F18 — 수정 전(재현)", () => {
  it("재실행 가능하도록 운영 원본 정의(롤백 파일)로 시작한다", () => { apply(ROLLBACK); });
  it("남은 미수 700원에 701원을 받아도 성공하고 수금 합이 1001원이 된다", async () => {
    ensureExtraStaff();
    const id = newUnpaid(1000);
    expect((await collect(owner(), id, { cash: 300 })).error).toBeNull();
    expect(unpaidOf(id)).toBe(700);
    expect((await collect(owner(), id, { cash: 701 })).error).toBeNull();     // 결함
    expect(collectedOf(id)).toBe(1001);
    expect(unpaidOf(id)).toBe(0);
  });
});

describe("F18 — 수정 후", () => {
  it("fix_collect_unpaid_overcollect_20261023.sql 적용(격리 DB)", async () => {
    apply(FIX);
    await new Promise((r) => setTimeout(r, 1500));
  });

  it("정상 일부 회수 → 정확한 완납 → 완납 후 재요청 거절", async () => {
    const id = newUnpaid(1000);
    expect((await collect(owner(), id, { cash: 300 })).error).toBeNull();
    expect(unpaidOf(id)).toBe(700);
    const over = await collect(owner(), id, { cash: 701 });
    expect(over.error?.message).toMatch(/남은 미수금\(700원\)보다 커요/);
    expect({ unpaid: unpaidOf(id), collected: collectedOf(id), rows: rowsOf(id) }).toEqual({ unpaid: 700, collected: 300, rows: 1 });   // 실패 시 아무 것도 안 바뀜
    expect((await collect(owner(), id, { cash: 700 })).error).toBeNull();                                                                     // 정확한 완납
    expect({ unpaid: unpaidOf(id), collected: collectedOf(id) }).toEqual({ unpaid: 0, collected: 1000 });
    const again = await collect(owner(), id, { cash: 1 });
    expect(again.error?.message).toMatch(/미수금이 없어요/);
    expect(collectedOf(id)).toBe(1000);
  });

  it("초과 1원은 거절, 수단별 합계(카드+현금+이체+포인트)로 비교한다", async () => {
    const id = newUnpaid(1000);
    expect((await collect(owner(), id, { card: 400, cash: 300, transfer: 200, point: 101 })).error?.message).toMatch(/받은 금액\(1001원\)이 남은 미수금\(1000원\)보다 커요/);
    expect(rowsOf(id)).toBe(0);
    expect((await collect(owner(), id, { card: 400, cash: 300, transfer: 200, point: 100 })).error).toBeNull();
    expect(unpaidOf(id)).toBe(0);
  });

  it("음수·0·모두 NULL·소수 금액은 거절하고 어떤 행도 만들지 않는다", async () => {
    const id = newUnpaid(1000);
    for (const a of [{ cash: -1 }, { cash: 500, card: -500 }, { cash: 0 }, { cash: null, card: null, transfer: null, point: null }, { cash: 0.5 }, { cash: 100.4 }]) {
      const r = await collect(owner(), id, a);
      expect(r.error, JSON.stringify(a)).not.toBeNull();
    }
    expect({ unpaid: unpaidOf(id), rows: rowsOf(id) }).toEqual({ unpaid: 1000, rows: 0 });
  });

  it("같은 금액의 정상 부분 회수 두 번은 막지 않는다(재시도와 합법 거래를 잔액 상한으로만 구분)", async () => {
    const id = newUnpaid(1000);
    expect((await collect(owner(), id, { cash: 300 })).error).toBeNull();
    expect((await collect(owner(), id, { cash: 300 })).error).toBeNull();
    expect({ unpaid: unpaidOf(id), collected: collectedOf(id), rows: rowsOf(id) }).toEqual({ unpaid: 400, collected: 600, rows: 2 });
  });

  it("동시 회수: 합계가 원 미수를 넘지 않는다", async () => {
    const id = newUnpaid(1000);
    const [a, b] = await Promise.all([collect(owner(), id, { cash: 600 }), collect(owner(), id, { cash: 600 })]);
    expect([a.error, b.error].filter((e) => e === null)).toHaveLength(1);
    expect(collectedOf(id)).toBe(600);
    expect(unpaidOf(id)).toBe(400);
    const id2 = newUnpaid(1000);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => collect(owner(), id2, { cash: 300 })));
    expect(rs.filter((r) => r.error === null)).toHaveLength(3);                          // 300×3=900 까지만, 4번째는 잔액 100 < 300
    expect(collectedOf(id2)).toBe(900);
    expect(unpaidOf(id2)).toBe(100);
    expect(collectedOf(id2) + unpaidOf(id2)).toBe(1000);
  });

  it("권한: 권한 없는 직원·다른 센터 오너·일반 회원·익명은 거절되고 데이터는 그대로", async () => {
    const id = newUnpaid(1000);
    for (const [name, c] of [["권한없는직원", clientFor(U2.S)], ["타센터오너", clientFor(U2.T)], ["일반회원", clientFor(U.A)], ["익명", clientFor(null)]] as const) {
      const r = await collect(c, id, { cash: 100 });
      expect(r.error, name).not.toBeNull();
    }
    expect({ unpaid: unpaidOf(id), rows: rowsOf(id) }).toEqual({ unpaid: 1000, rows: 0 });
  });

  it("다른 센터 결제를 이 센터 오너가 회수하려 하면 거절", async () => {
    const id = newUnpaid(1000, ID.centerPriv);
    expect((await collect(owner(), id, { cash: 100 })).error?.message).toMatch(/권한/);
    expect(unpaidOf(id)).toBe(1000);
  });

  it("회수 행·환불 행은 회수 대상이 아니다", async () => {
    const id = newUnpaid(1000);
    expect((await collect(owner(), id, { cash: 100 })).error).toBeNull();
    const child = sql(`select id from payments where linked_unpaid_payment_id='${id}'`);
    sql(`update payments set unpaid_amount=500 where id='${child}'`);   // 비정상 자료를 억지로 만들어도
    expect((await collect(owner(), child, { cash: 100 })).error?.message).toMatch(/회수 대상이 아니에요/);
  });

  it("실행 권한: anon 은 함수를 호출할 수 없다", () => {
    expect(sql(`select has_function_privilege('anon','public.collect_unpaid_payment(uuid,numeric,numeric,numeric,numeric,timestamptz,text)','execute')`)).toBe("f");
    expect(sql(`select has_function_privilege('authenticated','public.collect_unpaid_payment(uuid,numeric,numeric,numeric,numeric,timestamptz,text)','execute')`)).toBe("t");
  });
});
