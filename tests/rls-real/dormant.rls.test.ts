/* F19 — 휴면 복구 중복 연장. 격리 PostgreSQL + 실제 JWT. 구버전 앱 순서(extend RPC → center_members UPDATE)와 새 앱 순서(set_center_member_status)를 모두 확인한다.
   1) 수정 전: 같은 3일 휴면 회차에 병렬 복구 요청 2건이 모두 성공해 만료일이 +6일.
   2) fix_member_dormant_restore_idempotent_20261023.sql 적용 후: 한 회차는 +3일 한 번, 새 휴면 회차는 다시 처리 가능, 권한·센터 격리·잘못된 상태 원자성. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clientFor, ensureExtraStaff, ID, sql, U, U2 } from "./support";

const FIX = path.resolve(__dirname, "../../fix_member_dormant_restore_idempotent_20261023.sql");
const ROLLBACK = path.resolve(__dirname, "../../rollback_fix_member_dormant_restore_idempotent_20261023.sql");
const apply = (file: string) => execFileSync("docker", ["exec", "-i", "qa-rls-pg", "psql", "-U", "postgres", "-d", "qa", "-v", "ON_ERROR_STOP=1"], { input: fs.readFileSync(file, "utf8"), encoding: "utf8" });
const owner = () => clientFor(U.M);
const CM = "e7000000-0000-0000-0000-0000000000e7";
const MS = { count: "e8000000-0000-0000-0000-0000000000e1", period: "e8000000-0000-0000-0000-0000000000e2", expired: "e8000000-0000-0000-0000-0000000000e3", other: "e8000000-0000-0000-0000-0000000000e4" };
const BASE = { count: "2027-02-01", period: "2027-03-01", expired: "2027-01-01", other: "2027-04-01" };

function reset(dormantDaysAgo: number | null) {
  sql(`delete from memberships where id in ('${Object.values(MS).join("','")}')`);
  sql(`delete from center_members where id='${CM}'`);
  sql(`insert into center_members(id,center_id,profile_id,status,dormant_since) values ('${CM}','${ID.centerPub}','${ID.pB1}','${dormantDaysAgo === null ? "active" : "dormant"}',${dormantDaysAgo === null ? "null" : `now() - interval '${dormantDaysAgo} days 1 hour'`})`);
  const ins = (id: string, center: string, status: string, exp: string, ptype: string) =>
    sql(`insert into memberships(id,profile_id,center_id,product_name,total_count,remaining_count,expires_at,status,pass_type) values ('${id}','${ID.pB1}','${center}','QA','${ptype === "count" ? 10 : 0}',${ptype === "count" ? 5 : 0},'${exp}','${status}','${ptype}')`);
  ins(MS.count, ID.centerPub, "active", BASE.count, "count");
  ins(MS.period, ID.centerPub, "active", BASE.period, "period");
  ins(MS.expired, ID.centerPub, "expired", BASE.expired, "count");
  ins(MS.other, ID.centerPriv, "active", BASE.other, "count");
}
const exp = () => Object.fromEntries(Object.entries(MS).map(([k, id]) => [k, sql(`select expires_at from memberships where id='${id}'`)]));
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const cm = () => sql(`select status||'|'||coalesce(dormant_since::text,'')  from center_members where id='${CM}'`);

afterAll(() => { sql(`delete from memberships where id in ('${Object.values(MS).join("','")}')`); sql(`delete from center_members where id='${CM}'`); });   // 다른 테스트 파일에 상태를 남기지 않는다

describe("F19 — 수정 전(재현)", () => {
  it("운영 원본 정의(롤백 파일)로 시작", () => { apply(ROLLBACK); });
  it("같은 3일 휴면 회차에 병렬 복구 요청 2건이 모두 성공해 +6일 연장된다", async () => {
    ensureExtraStaff(); reset(3);
    const calls = await Promise.all([owner().rpc("extend_passes_after_dormant", { p_center_member_id: CM }), owner().rpc("extend_passes_after_dormant", { p_center_member_id: CM })]);
    expect(calls.map((c) => c.error)).toEqual([null, null]);
    expect(calls.map((c) => c.data)).toEqual([2, 2]);
    const e = exp();
    expect(e.count).toBe(addDays(BASE.count, 6)); expect(e.period).toBe(addDays(BASE.period, 6));   // 결함
  });
});

describe("F19 — 수정 후", () => {
  it("fix_member_dormant_restore_idempotent_20261023.sql 적용(격리 DB)", async () => { apply(FIX); await new Promise((r) => setTimeout(r, 1500)); });

  it("[구버전 앱 순서] extend RPC 병렬 2건 → 연장은 +3일 한 번, 이후 center_members UPDATE 도 정상", async () => {
    reset(3);
    const calls = await Promise.all([owner().rpc("extend_passes_after_dormant", { p_center_member_id: CM }), owner().rpc("extend_passes_after_dormant", { p_center_member_id: CM })]);
    expect(calls.map((c) => c.error)).toEqual([null, null]);
    expect((calls.map((c) => c.data) as number[]).sort()).toEqual([0, 2]);
    expect(exp()).toEqual({ count: addDays(BASE.count, 3), period: addDays(BASE.period, 3), expired: BASE.expired, other: BASE.other });   // 만료 상태·다른 센터는 그대로
    const upd = await owner().from("center_members").update({ status: "active", dormant_since: null }).eq("id", CM);   // 구버전 앱의 2단계
    expect(upd.error).toBeNull();
    expect(cm()).toBe("active|");
    expect((await owner().rpc("extend_passes_after_dormant", { p_center_member_id: CM })).data).toBe(0);               // 이미 활성이면 0
    expect(exp().count).toBe(addDays(BASE.count, 3));
  });

  it("[새 앱] set_center_member_status 병렬 'active' 2건 → +3일 한 번, 상태·시작 시각 정리", async () => {
    reset(3);
    const rs = await Promise.all([owner().rpc("set_center_member_status", { p_center_member_id: CM, p_status: "active" }), owner().rpc("set_center_member_status", { p_center_member_id: CM, p_status: "active" })]);
    expect(rs.map((r) => r.error)).toEqual([null, null]);
    expect((rs.map((r) => (r.data as { daysAdded: number }).daysAdded)).sort()).toEqual([0, 3]);
    expect(exp().count).toBe(addDays(BASE.count, 3));
    expect(exp().period).toBe(addDays(BASE.period, 3));
    expect(cm()).toBe("active|");
    const again = await owner().rpc("set_center_member_status", { p_center_member_id: CM, p_status: "active" });
    expect((again.data as { daysAdded: number }).daysAdded).toBe(0);
    expect(exp().count).toBe(addDays(BASE.count, 3));
  });

  it("나중에 새로 시작한 정상 휴면 회차는 다시 처리되고, 같은 회차 재요청은 시작 시각을 덮어쓰지 않는다", async () => {
    reset(3);
    expect((await owner().rpc("set_center_member_status", { p_center_member_id: CM, p_status: "active" })).error).toBeNull();
    expect((await owner().rpc("set_center_member_status", { p_center_member_id: CM, p_status: "dormant" })).error).toBeNull();
    const since1 = sql(`select dormant_since from center_members where id='${CM}'`);
    expect(since1).not.toBe("");
    expect((await owner().rpc("set_center_member_status", { p_center_member_id: CM, p_status: "dormant" })).error).toBeNull();   // 이미 휴면
    expect(sql(`select dormant_since from center_members where id='${CM}'`)).toBe(since1);
    sql(`update center_members set dormant_since = now() - interval '2 days 1 hour' where id='${CM}'`);                              // 2일 경과로 만든다
    const r = await owner().rpc("set_center_member_status", { p_center_member_id: CM, p_status: "active" });
    expect((r.data as { daysAdded: number }).daysAdded).toBe(2);
    expect(exp().count).toBe(addDays(BASE.count, 3 + 2));
  });

  it("경계: 24시간 미만 휴면은 연장 0일이지만 회차는 소비된다 / 만료(expired) 복귀도 연장 규칙 동일", async () => {
    reset(0);
    sql(`update center_members set dormant_since = now() - interval '23 hours' where id='${CM}'`);
    const r = await owner().rpc("set_center_member_status", { p_center_member_id: CM, p_status: "expired" });
    expect((r.data as { daysAdded: number }).daysAdded).toBe(0);
    expect(exp().count).toBe(BASE.count);
    expect(cm()).toBe("expired|");
  });

  it("잘못된 상태·없는 회원은 거절되고 아무 것도 바뀌지 않는다", async () => {
    reset(3);
    const bad = await owner().rpc("set_center_member_status", { p_center_member_id: CM, p_status: "deleted" });
    expect(bad.error?.message).toMatch(/활성\/만료\/휴면/);
    const none = await owner().rpc("set_center_member_status", { p_center_member_id: "00000000-0000-0000-0000-000000000000", p_status: "active" });
    expect(none.error?.message).toMatch(/찾을 수 없어요/);
    expect(exp()).toEqual(BASE); expect(cm().startsWith("dormant|")).toBe(true);
  });

  it("권한: 권한 없는 직원·다른 센터 오너·일반 회원·익명은 거절", async () => {
    reset(3);
    for (const [name, c] of [["권한없는직원", clientFor(U2.S)], ["타센터오너", clientFor(U2.T)], ["일반회원", clientFor(U.A)], ["익명", clientFor(null)]] as const) {
      expect((await c.rpc("set_center_member_status", { p_center_member_id: CM, p_status: "active" })).error, `${name} new`).not.toBeNull();
      expect((await c.rpc("extend_passes_after_dormant", { p_center_member_id: CM })).error, `${name} old`).not.toBeNull();
    }
    expect(exp()).toEqual(BASE); expect(cm().startsWith("dormant|")).toBe(true);
  });
});
