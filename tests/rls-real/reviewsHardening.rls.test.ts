/* 후기 답글·식별 컬럼 보호. 격리 PostgREST + 실제 JWT: 작성자(B)·다른 회원(A)·센터 직원(S: 권한 키 없는 역할)·센터 오너(M)·다른 센터 오너(T)·익명.
   수정 전: 작성자가 reply/hidden/center_id 를 직접 바꾸고 직원이 회원 본문을 직접 고쳐 쓸 수 있음을 재현 → fix_center_reviews_write_hardening_20261023.sql 적용 후 직접 쓰기 전부 거절, 정상 경로(write/update_my_review/reply_review)는 그대로. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clientFor, ensureExtraStaff, ID, sql, U, U2 } from "./support";

const apply = (f: string) => execFileSync("docker", ["exec", "-i", "qa-rls-pg", "psql", "-U", "postgres", "-d", "qa", "-v", "ON_ERROR_STOP=1"], { input: fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8"), encoding: "utf8" });
const member = () => clientFor(U.B);
const manager = () => clientFor(U.M);
const staff = () => clientFor(U2.S);
const wait = () => new Promise((r) => setTimeout(r, 1500));
const rid = () => sql(`select id from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
const row = () => sql(`select rating||'|'||content||'|'||coalesce(reply,'')||'|'||hidden||'|'||center_id||'|'||profile_id from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
function fresh() {
  sql(`delete from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
  sql(`insert into center_reviews(center_id,profile_id,rating,content) values ('${ID.centerPub}','${ID.pB1}',4,'원문')`);
}

afterAll(() => { sql(`delete from point_transactions where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`); sql(`delete from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`); });

describe("후기 직접 쓰기 — 수정 전(재현)", () => {
  it("준비: 기존 grant 상태로 복원 + 보조 마이그레이션", async () => {
    ensureExtraStaff();
    apply("rollback_fix_center_reviews_write_hardening_20261023.sql");
    apply("fix_write_review_unified_ledger_20261022.sql");
    await wait();
  });
  it("작성자가 자기 후기의 관리자 답글·숨김·센터를 직접 PATCH 할 수 있고, 직원이 회원 본문을 직접 고칠 수 있다", async () => {
    fresh();
    const a = await member().from("center_reviews").update({ reply: "위조된 답글", hidden: true }).eq("id", rid());
    expect(a.error).toBeNull();
    expect(row()).toContain("위조된 답글");
    const b = await staff().from("center_reviews").update({ content: "직원이 바꾼 본문" }).eq("id", rid());
    expect(b.error).toBeNull();
    expect(row()).toContain("직원이 바꾼 본문");
    const c = await member().from("center_reviews").insert({ center_id: ID.centerPub, profile_id: ID.pA1, rating: 5, content: "x" });   // 남의 프로필: RLS 로 막힘(참고)
    expect(c.error).not.toBeNull();
  });
});

describe("후기 직접 쓰기 — 하드닝 적용 후", () => {
  it("fix_center_reviews_write_hardening_20261023.sql 적용(격리 DB)", async () => { apply("fix_center_reviews_write_hardening_20261023.sql"); await wait(); });

  it("작성자: reply / replied_at / hidden / center_id / profile_id / rating / content 직접 PATCH 전부 거절, 행 불변", async () => {
    fresh();
    const before = row();
    for (const patch of [{ reply: "위조" }, { replied_at: new Date().toISOString() }, { hidden: true }, { center_id: ID.centerPriv }, { profile_id: ID.pA1 }, { rating: 1 }, { content: "직접 수정" }, { created_at: "2020-01-01T00:00:00Z" }]) {
      const r = await member().from("center_reviews").update(patch).eq("id", rid()).select();
      expect(r.error, JSON.stringify(patch)).not.toBeNull();
    }
    expect(row()).toBe(before);
  });

  it("직원(권한 없는 역할)·다른 센터 오너·다른 회원·익명: 직접 PATCH 거절", async () => {
    fresh();
    const before = row();
    for (const [name, c] of [["직원", staff()], ["오너", manager()], ["타센터오너", clientFor(U2.T)], ["다른회원", clientFor(U.A)], ["익명", clientFor(null)]] as const) {
      const r = await c.from("center_reviews").update({ content: "직접", reply: "직접" }).eq("id", rid()).select();
      expect(r.error, name).not.toBeNull();
    }
    expect(row()).toBe(before);
  });

  it("직접 INSERT 는 작성자 입력 컬럼(별점·본문·사진)만 허용 — reply/hidden 을 채운 INSERT 는 거절", async () => {
    sql(`delete from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
    const bad = await member().from("center_reviews").insert({ center_id: ID.centerPub, profile_id: ID.pB1, rating: 5, content: "x", reply: "위조" });
    expect(bad.error).not.toBeNull();
    const bad2 = await member().from("center_reviews").insert({ center_id: ID.centerPub, profile_id: ID.pB1, rating: 5, content: "x", hidden: true });
    expect(bad2.error).not.toBeNull();
    expect(sql(`select count(*) from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`)).toBe("0");
    const ok = await member().from("center_reviews").insert({ center_id: ID.centerPub, profile_id: ID.pB1, rating: 5, content: "정상" });
    expect(ok.error).toBeNull();                                                          // 기존 호환: 허용 컬럼 INSERT 는 계속 가능(본 경로는 write_review)
    const other = await member().from("center_reviews").insert({ center_id: ID.centerPub, profile_id: ID.pA1, rating: 5, content: "남의 프로필" });
    expect(other.error).not.toBeNull();                                                   // RLS 로 계속 거절
  });

  it("정상 경로: 작성자 update_my_review(별점·본문·사진, 답글·id 보존), 직원·오너 reply_review, 무권한은 거절", async () => {
    sql(`delete from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
    const w = await member().rpc("write_review", { p_center_id: ID.centerPub, p_profile_id: ID.pB1, p_rating: 5, p_content: "처음", p_photos: null });
    expect(w.error).toBeNull();
    const id = rid();
    expect((await manager().rpc("reply_review", { p_review_id: id, p_reply: "오너 답변" })).error).toBeNull();
    expect(row()).toContain("오너 답변");
    expect((await staff().rpc("reply_review", { p_review_id: id, p_reply: "직원 답변" })).error).toBeNull();   // 현행 모델: 센터 활성 직원은 답변 가능(전용 권한 키 없음 — 정책 결정 항목)
    expect(row()).toContain("직원 답변");
    const upd = await member().rpc("update_my_review", { p_review_id: id, p_rating: 3, p_content: "수정본", p_photos: ["reviews/z.jpg"] });
    expect(upd.error).toBeNull();
    expect(rid()).toBe(id);
    expect(row()).toBe(`3|수정본|직원 답변|false|${ID.centerPub}|${ID.pB1}`);
    for (const [name, c] of [["타센터오너", clientFor(U2.T)], ["다른회원", clientFor(U.A)], ["작성자", member()], ["익명", clientFor(null)]] as const) {
      expect((await c.rpc("reply_review", { p_review_id: id, p_reply: "무권한" })).error, name).not.toBeNull();
    }
    expect((await clientFor(U.A).rpc("update_my_review", { p_review_id: id, p_rating: 1, p_content: "남의 후기", p_photos: null })).error).not.toBeNull();
    expect(row()).toContain("직원 답변");
  });

  it("권한 상태: anon/authenticated 에 center_reviews UPDATE 없음, INSERT 는 5컬럼만, reply_review 는 anon 실행 불가", () => {
    expect(sql(`select has_table_privilege('authenticated','public.center_reviews','update')`)).toBe("f");
    expect(sql(`select has_table_privilege('anon','public.center_reviews','update')`)).toBe("f");
    expect(sql(`select count(*) from information_schema.column_privileges where table_name='center_reviews' and grantee='authenticated' and privilege_type='INSERT'`)).toBe("5");
    expect(sql(`select has_table_privilege('authenticated','public.center_reviews','select')`)).toBe("t");
    expect(sql(`select has_function_privilege('anon','public.reply_review(uuid,text)','execute')`)).toBe("f");
  });
});
