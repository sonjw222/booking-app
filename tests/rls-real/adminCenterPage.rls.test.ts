/* admin_list_centers_page / admin_list_centers 권한·입력 경계(격리 PostgreSQL + 실제 JWT). 플랫폼 관리자 계정은 격리 DB 안에서만 만든다. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientFor, ID, sql, U } from "./support";

const ADMIN = "66666666-6666-6666-6666-666666666666";
const AID = "d6600000-0000-0000-0000-0000000000d7";
beforeAll(() => {
  sql(`insert into auth.users(id,email) values ('${ADMIN}','platform2@test.invalid') on conflict do nothing`);
  sql(`insert into accounts(id,auth_id,name,is_platform_admin) values ('${AID}','${ADMIN}','격리 플랫폼 관리자2',true) on conflict (id) do update set is_platform_admin=true`);
});
afterAll(() => {
  sql(`delete from profiles where account_id='${AID}'`); sql(`delete from accounts where id='${AID}'`); sql(`delete from auth.users where id='${ADMIN}'`);
});
const page = (c: ReturnType<typeof clientFor>, o: Record<string, unknown> = {}) => c.rpc("admin_list_centers_page", { p_status: "approved", p_keyword: "", p_limit: 30, p_before_created_at: null, p_before_id: null, ...o });

describe("관리자 센터 페이지 RPC 접근·입력", () => {
  it("익명·일반 회원·센터 오너는 거절되고, 플랫폼 관리자는 최대 limit+1 행만 받는다", async () => {
    expect((await page(clientFor(null))).error).not.toBeNull();
    expect((await page(clientFor(U.A))).error).not.toBeNull();
    expect((await page(clientFor(U.M))).error).not.toBeNull();
    for (const c of [clientFor(null), clientFor(U.A), clientFor(U.M)]) expect((await c.rpc("admin_list_centers", { p_status: "approved" })).error).not.toBeNull();
    const ok = await page(clientFor(ADMIN), { p_limit: 5 });
    expect(ok.error).toBeNull();
    expect((ok.data as unknown[]).length).toBeLessThanOrEqual(6);
  });
  it("잘못된 입력(상태·limit·커서 쌍)은 거절된다", async () => {
    const a = clientFor(ADMIN);
    expect((await page(a, { p_status: "deleted" })).error).not.toBeNull();
    expect((await page(a, { p_limit: 0 })).error).not.toBeNull();
    expect((await page(a, { p_limit: 1000 })).error).not.toBeNull();
    expect((await page(a, { p_before_created_at: "2026-10-01T00:00:00Z", p_before_id: null })).error).not.toBeNull();
  });
  it("검색어의 % 와 _ 는 리터럴로 취급된다(전체 일치로 번지지 않음)", async () => {
    const r = await page(clientFor(ADMIN), { p_status: "approved", p_keyword: "%" });
    expect(r.error).toBeNull();
    expect((r.data as unknown[]).length).toBe(Number(sql(`select count(*) from centers where status='approved' and (name ilike '%\\%%' or coalesce(address,'') ilike '%\\%%' or coalesce(phone,'') ilike '%\\%%')`)));
    void ID;
  });
});
