/* F20 서버 측: 운영 설정을 저장할 권한이 없는 직원·일반 회원은 center_settings 를 바꿀 수 없다(조회 범위는 기존 정책 그대로 — 이번 변경으로 넓히지 않음). */
import { describe, expect, it } from "vitest";
import { clientFor, ensureExtraStaff, ID, sql, U, U2 } from "./support";

describe("F20 — center_settings 쓰기 권한", () => {
  it("권한 없는 직원·타 센터 오너·일반 회원·익명은 UPDATE 가 거절되거나 0행, 오너는 가능", async () => {
    ensureExtraStaff();
    sql(`update center_settings set daily_book_limit_enabled=false, daily_book_limit=null where center_id='${ID.centerPub}'`);
    for (const [name, c] of [["권한없는직원", clientFor(U2.S)], ["타센터오너", clientFor(U2.T)], ["일반회원", clientFor(U.A)], ["익명", clientFor(null)]] as const) {
      const r = await c.from("center_settings").update({ daily_book_limit_enabled: true, daily_book_limit: 5 }).eq("center_id", ID.centerPub).select();
      expect(r.error !== null || (r.data ?? []).length === 0, `${name}: ${JSON.stringify(r)}`).toBe(true);
    }
    expect(sql(`select daily_book_limit_enabled||'|'||coalesce(daily_book_limit::text,'') from center_settings where center_id='${ID.centerPub}'`)).toBe("false|");
    const ok = await clientFor(U.M).from("center_settings").update({ daily_book_limit_enabled: true, daily_book_limit: 3 }).eq("center_id", ID.centerPub).select();
    expect(ok.error).toBeNull();
    expect(ok.data).toHaveLength(1);
    sql(`update center_settings set daily_book_limit_enabled=false, daily_book_limit=null where center_id='${ID.centerPub}'`);
  });
});
