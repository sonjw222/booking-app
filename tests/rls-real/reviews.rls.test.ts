/* F13 — 후기 보상 장부 불일치·수정 시 중복 보상. 격리 PostgreSQL(저장소 마이그레이션 적용) + 실제 회원/관리자 JWT.
   1) 수정 전(저장소의 옛 정의 그대로): 사진 인자가 있는 5인자 write_review 가 옛 장부에만 적립하고, 수정(삭제 후 재작성)이 보상을 중복 지급함을 재현한다.
   2) fix_write_review_unified_ledger_20261022.sql 을 적용한 뒤: 통합 원장 1회 적립, 수정 보상 0회, 후기 ID·관리자 답변 보존, 중복·동시 요청 1회, 타 계정 차단. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientFor, ID, sql, U } from "./support";

const member = () => clientFor(U.B);
const other = () => clientFor(U.A);
const manager = () => clientFor(U.M);
const FIX = path.resolve(__dirname, "../../fix_write_review_unified_ledger_20261022.sql");
const unified = () => Number(sql(`select coalesce(sum(amount),0) from point_transactions where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`));
const legacy = () => Number(sql(`select coalesce(sum(balance),0) from point_accounts where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`));
const legacyLogs = () => Number(sql(`select count(*) from point_logs where profile_id='${ID.pB1}' and center_id='${ID.centerPub}' and reason='review'`));
const reviewRows = () => sql(`select id||'|'||rating||'|'||content||'|'||coalesce(reply,'')||'|'||coalesce(photos::text,'') from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
const reset = () => { sql(`delete from point_transactions where profile_id='${ID.pB1}' and center_id='${ID.centerPub}' and reason like '%후기%'`); sql(`delete from point_logs where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`); sql(`delete from point_accounts where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`); sql(`delete from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`); };
const write = (rating = 5, content = "좋아요", photos: string[] | null = null) => member().rpc("write_review", { p_center_id: ID.centerPub, p_profile_id: ID.pB1, p_rating: rating, p_content: content, p_photos: photos });

describe("F13 — 수정 전(재현)", () => {
  it("사진 인자가 있는 write_review 는 옛 장부에 적립하고 통합 원장(회원이 보는 잔액)은 0 — 수정(삭제 후 재작성)은 보상을 중복 지급한다", async () => {
    reset();
    const first = await write(5, "처음", ["reviews/a.jpg"]);
    expect(first.error).toBeNull();
    expect((first.data as { point: number }).point).toBe(1000);
    expect({ unified: unified(), legacy: legacy(), legacyLogs: legacyLogs() }).toEqual({ unified: 0, legacy: 1000, legacyLogs: 1 });   // 보상이 쓰이지 않는 장부에 쌓임
    const bal = await member().rpc("my_point_balance", { p_center_id: ID.centerPub, p_profile_id: ID.pB1 });
    expect(Number(bal.data)).toBe(0);                                                                                                  // 회원 화면 잔액
    // 옛 수정 방식: 삭제 후 재작성
    const id = sql(`select id from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
    expect((await member().from("center_reviews").delete().eq("id", id)).error).toBeNull();
    expect((await write(4, "수정", ["reviews/a.jpg"])).error).toBeNull();
    expect({ legacy: legacy(), legacyLogs: legacyLogs() }).toEqual({ legacy: 2000, legacyLogs: 2 });                                   // 수정 때 보상이 다시 지급됨 + 후기 ID 변경
    expect(sql(`select id from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`)).not.toBe(id);
    reset();
  });
});

describe("F13 — 마이그레이션 적용 후", () => {
  it("fix_write_review_unified_ledger_20261022.sql 적용(격리 DB)", async () => {
    execFileSync("docker", ["exec", "-i", "qa-rls-pg", "psql", "-U", "postgres", "-d", "qa", "-v", "ON_ERROR_STOP=1"], { input: fs.readFileSync(FIX, "utf8"), encoding: "utf8" });
    expect(sql(`select count(*) from pg_proc where proname in ('write_review','update_my_review')`)).toBe("3");   // 5인자 + 4인자 래퍼 + update
    await new Promise((r) => setTimeout(r, 1500));                                                                // PostgREST 스키마 캐시 갱신 대기
  });

  it("작성: 사진 유무와 관계없이 통합 원장에 1회 적립(회원 잔액·원장 일치), 옛 장부는 늘지 않는다", async () => {
    reset();
    const r1 = await write(5, "사진 없음", null);
    expect(r1.error).toBeNull();
    expect((r1.data as { point: number }).point).toBe(1000);
    expect(unified()).toBe(1000);
    expect((await member().rpc("my_point_balance", { p_center_id: ID.centerPub, p_profile_id: ID.pB1 })).data).toBe(1000);
    expect({ legacy: legacy(), legacyLogs: legacyLogs() }).toEqual({ legacy: 0, legacyLogs: 0 });
    expect(sql(`select count(*) from point_transactions where profile_id='${ID.pB1}' and reason='후기 작성 적립' and review_id is not null`)).toBe("1");
    // 관리자도 같은 잔액을 본다(관리자 포인트 원장 조회 = 통합 원장)
    const mgr = await manager().from("point_transactions").select("amount").eq("profile_id", ID.pB1).eq("center_id", ID.centerPub);
    expect(mgr.error).toBeNull();
    expect((mgr.data as { amount: number }[]).reduce((a, b) => a + b.amount, 0)).toBe(1000);
  });

  it("중복·재시도·동시 요청에도 보상은 1회(후기도 1건)", async () => {
    const again = await write(3, "재시도");
    expect(again.error?.message).toMatch(/이미 이 센터에 후기를 작성했어요/);
    expect(unified()).toBe(1000);
    reset();
    const [a, b] = await Promise.all([write(5, "동시 1"), write(5, "동시 2")]);
    expect([a.error, b.error].filter((e) => e === null)).toHaveLength(1);
    expect(unified()).toBe(1000);
    expect(sql(`select count(*) from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`)).toBe("1");
  });

  it("수정: 같은 행을 바꾸고 후기 ID·관리자 답변·보상 이력을 보존하며 보상은 0회", async () => {
    const id = sql(`select id from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
    expect((await manager().rpc("reply_review", { p_review_id: id, p_reply: "감사합니다" })).error).toBeNull();
    const upd = await member().rpc("update_my_review", { p_review_id: id, p_rating: 3, p_content: "수정된 내용", p_photos: ["reviews/b.jpg"] });
    expect(upd.error).toBeNull();
    expect((upd.data as { point: number }).point).toBe(0);
    const row = reviewRows().split("|");
    expect(row[0]).toBe(id);
    expect(row.slice(1)).toEqual(["3", "수정된 내용", "감사합니다", "{reviews/b.jpg}"]);       // ID 동일, 답변 유지
    expect(unified()).toBe(1000);                                                                // 수정 보상 없음
    expect(sql(`select count(*) from point_transactions where review_id='${id}'`)).toBe("1");
  });

  it("권한: 타 계정은 내 후기를 수정할 수 없고, 별점 범위를 지키며, 비로그인은 호출할 수 없다", async () => {
    const id = sql(`select id from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
    expect((await other().rpc("update_my_review", { p_review_id: id, p_rating: 1, p_content: "침해", p_photos: null })).error?.message).toMatch(/내 후기를 찾을 수 없어요/);
    expect((await member().rpc("update_my_review", { p_review_id: id, p_rating: 9, p_content: "범위", p_photos: null })).error?.message).toMatch(/별점/);
    expect((await clientFor(null).rpc("update_my_review", { p_review_id: id, p_rating: 5, p_content: "익명", p_photos: null })).error).not.toBeNull();
    expect((await other().rpc("write_review", { p_center_id: ID.centerPub, p_profile_id: ID.pB1, p_rating: 5, p_content: "남의 프로필", p_photos: null })).error?.message).toMatch(/본인 프로필/);
    expect(reviewRows()).toContain("수정된 내용");
  });

  it("[관찰 + 별도 제안 검증] 작성자가 직접 UPDATE 로 관리자 답변 컬럼을 바꿀 수 있는지(기존 RLS) / 컬럼 제한 제안 적용 시", async () => {
    const id = sql(`select id from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
    const forge = await member().from("center_reviews").update({ reply: "위조된 답변" }).eq("id", id).select("reply");
    console.log(`[관찰] 작성자 직접 UPDATE reply → ${forge.error ? "거부(" + forge.error.message + ")" : "허용, reply=" + JSON.stringify((forge.data as { reply: string }[] | null)?.[0]?.reply)}`);
    sql(`update center_reviews set reply='감사합니다' where id='${id}'`);
    // 별도 제안(harden_center_reviews_update_columns_20261022.sql)을 격리 DB에 적용하면 위조가 막히고 정상 수정·답변 경로는 그대로다.
    execFileSync("docker", ["exec", "-i", "qa-rls-pg", "psql", "-U", "postgres", "-d", "qa", "-v", "ON_ERROR_STOP=1"], { input: fs.readFileSync(path.resolve(__dirname, "../../harden_center_reviews_update_columns_20261022.sql"), "utf8"), encoding: "utf8" });
    await new Promise((r) => setTimeout(r, 1500));
    const blocked = await member().from("center_reviews").update({ reply: "위조된 답변" }).eq("id", id).select("reply");
    expect(blocked.error, "reply 직접 UPDATE 는 권한 오류").not.toBeNull();
    expect((await member().rpc("update_my_review", { p_review_id: id, p_rating: 4, p_content: "경화 후 수정", p_photos: null })).error).toBeNull();   // 정상 수정 경로 유지
    expect((await manager().rpc("reply_review", { p_review_id: id, p_reply: "감사합니다" })).error).toBeNull();                                     // 관리자 답변 경로 유지
    sql(`update center_reviews set rating=3, content='수정된 내용' where id='${id}'`);
  });

  it("[현행 정책 관찰] 후기를 삭제하고 다시 쓰면 새 행에 보상이 다시 지급된다 — 정책 결정 사항(이번 변경은 정책을 바꾸지 않음)", async () => {
    const id = sql(`select id from center_reviews where profile_id='${ID.pB1}' and center_id='${ID.centerPub}'`);
    expect((await member().from("center_reviews").delete().eq("id", id)).error).toBeNull();
    expect(unified()).toBe(1000);                                  // 삭제해도 보상은 회수되지 않는다(앱 안내와 동일)
    expect((await write(5, "삭제 후 재작성")).error).toBeNull();
    console.log(`[관찰] 삭제 후 재작성 → 통합 원장 ${unified()}P (현행 정책: 재지급됨)`);
    expect(unified()).toBe(2000);
    reset();
  });
});
