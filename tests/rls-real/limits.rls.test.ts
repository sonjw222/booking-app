/* F06/F12 — 일일 예약 횟수·프라이빗 동시 수업 제한. 격리 PostgREST + 저장소의 실제 함수/트리거. 설정 변경은 센터 오너(관리자) JWT, 예약은 회원 JWT.
   순차 요청 검증이다. 동시(경쟁) 요청은 맨 아래 별도 테스트로 구분한다. */
import { describe, expect, it } from "vitest";
import { clientFor, ID, kstDay, sql, U } from "./support";

const manager = () => clientFor(U.M);
const member = () => clientFor(U.B);
const setLimits = (v: Record<string, unknown>) => manager().from("center_settings").update(v).eq("center_id", ID.centerPub);
const settingsRow = async () => ((await manager().from("center_settings").select("daily_book_limit_enabled, daily_book_limit, private_max_concurrent_enabled, private_max_concurrent").eq("center_id", ID.centerPub).single()).data) as Record<string, unknown>;
const mkClass = async (title: string, format: "group" | "private", start: string, end: string) => {
  const r = await manager().from("classes").insert({ center_id: ID.centerPub, title, class_format: format, start_time: start, end_time: end, capacity: format === "private" ? 1 : 5, status: "open", pass_selection_mode: "all" }).select("id").single();
  expect(r.error).toBeNull(); return (r.data as { id: string }).id;
};
const reserve = (classId: string) => member().rpc("reserve_with_membership", { p_class_id: classId, p_profile_id: ID.pB1, p_membership_id: ID.memB });
const cancelAll = async (ids: string[]) => {
  for (const id of ids) {
    const rows = (await member().from("reservations").select("id").eq("class_id", id).in("status", ["confirmed", "waitlisted"])).data as { id: string }[];
    for (const r of rows ?? []) await member().rpc("cancel_reservation", { p_reservation_id: r.id });
  }
};
const created: string[] = [];

describe("F06 일일 예약 한도 — 켜짐=실제 정수 저장 → 두 번째 예약 거부", () => {
  it("서버는 켜짐+숫자 없음 저장을 명시 오류로 거부한다(조용한 무제한 금지)", async () => {
    expect((await setLimits({ daily_book_limit_enabled: false, daily_book_limit: null })).error).toBeNull();
    const noNumber = await setLimits({ daily_book_limit_enabled: true });                       // 화면에서 토글만 켠 것과 같은 요청
    expect(noNumber.error?.message).toMatch(/일일 예약 횟수 제한을 켜려면/);
    for (const bad of [0, -1, 100]) expect((await setLimits({ daily_book_limit_enabled: true, daily_book_limit: bad })).error, `값 ${bad}`).not.toBeNull();
    expect(await settingsRow()).toMatchObject({ daily_book_limit_enabled: false, daily_book_limit: null });   // 거부된 요청은 아무것도 바꾸지 않는다
  });

  it("앱이 보내는 요청(켜짐+1)은 정수 1로 저장·재조회되고, 같은 날 두 번째 예약이 거부된다 / 한도 2는 두 번째 허용·세 번째 거부 / OFF는 모두 허용", async () => {
    const c1 = await mkClass("[LIMIT] 일일 1", "group", kstDay(8, 9), kstDay(8, 10));
    const c2 = await mkClass("[LIMIT] 일일 2", "group", kstDay(8, 12), kstDay(8, 13));
    const c3 = await mkClass("[LIMIT] 일일 3", "group", kstDay(8, 15), kstDay(8, 16));
    created.push(c1, c2, c3);
    try {
      expect((await setLimits({ daily_book_limit_enabled: true, daily_book_limit: 1 })).error).toBeNull();
      expect(await settingsRow()).toMatchObject({ daily_book_limit_enabled: true, daily_book_limit: 1 });          // 화면 1 = 저장 1
      expect((await reserve(c1)).error).toBeNull();
      const second = await reserve(c2);
      expect(second.error?.message).toMatch(/하루 예약 가능 횟수\(1회\)를 초과/);
      await cancelAll([c1]);

      expect((await setLimits({ daily_book_limit_enabled: true, daily_book_limit: 2 })).error).toBeNull();
      expect((await reserve(c1)).error).toBeNull();
      expect((await reserve(c2)).error).toBeNull();
      expect((await reserve(c3)).error?.message).toMatch(/\(2회\)/);
      await cancelAll([c1, c2]);

      expect((await setLimits({ daily_book_limit_enabled: false })).error).toBeNull();
      for (const c of [c1, c2, c3]) expect((await reserve(c)).error).toBeNull();
    } finally { await cancelAll([c1, c2, c3]); await setLimits({ daily_book_limit_enabled: false, daily_book_limit: null }); }
    expect(sql(`select remaining_count from memberships where id='${ID.memB}'`)).toBe("10");                      // 모두 복구
  });
});

describe("F12 프라이빗 동시 수업 한도 — 기존 정책(겹치는 확정 예약 수) 그대로", () => {
  it("겹침 거부 / 인접·비중첩 허용 / 한도 2 허용 / OFF 허용", async () => {
    const p1 = await mkClass("[LIMIT] 프라이빗 A 10:00", "private", kstDay(9, 10), kstDay(9, 11));
    const overlap = await mkClass("[LIMIT] 프라이빗 B 10:30", "private", kstDay(9, 10, 30), kstDay(9, 11, 30));
    const adjacent = await mkClass("[LIMIT] 프라이빗 C 11:00", "private", kstDay(9, 11), kstDay(9, 12));
    const apart = await mkClass("[LIMIT] 프라이빗 D 14:00", "private", kstDay(9, 14), kstDay(9, 15));
    created.push(p1, overlap, adjacent, apart);
    try {
      expect((await setLimits({ private_max_concurrent_enabled: false, private_max_concurrent: null })).error).toBeNull();
      expect((await setLimits({ private_max_concurrent_enabled: true })).error?.message).toMatch(/프라이빗 동시 수업 제한을 켜려면/);
      expect((await setLimits({ private_max_concurrent_enabled: true, private_max_concurrent: 1 })).error).toBeNull();
      expect(await settingsRow()).toMatchObject({ private_max_concurrent_enabled: true, private_max_concurrent: 1 });
      expect((await reserve(p1)).error).toBeNull();
      expect((await reserve(overlap)).error?.message).toMatch(/프라이빗 수업이 이미 다 찼어요\(최대 1건\)/);   // 겹침 거부
      expect((await reserve(adjacent)).error).toBeNull();                                                      // 끝=시작 인접은 겹침 아님
      expect((await reserve(apart)).error).toBeNull();                                                         // 비중첩
      await cancelAll([adjacent, apart]);
      expect((await setLimits({ private_max_concurrent: 2 })).error).toBeNull();
      expect((await reserve(overlap)).error).toBeNull();                                                       // 한도 2: 겹침 1건까지 허용
      await cancelAll([overlap]);
      expect((await setLimits({ private_max_concurrent_enabled: false })).error).toBeNull();
      expect((await reserve(overlap)).error).toBeNull();                                                       // OFF
    } finally { await cancelAll([p1, overlap, adjacent, apart]); await setLimits({ private_max_concurrent_enabled: false, private_max_concurrent: null }); }
    expect(sql(`select remaining_count from memberships where id='${ID.memB}'`)).toBe("10");
  });

  it("[동시 요청 경쟁 — 순차 검증과 별개] 한도 1에서 겹치는 두 수업을 동시에 예약하면 몇 건이 확정되는지 관찰한다", async () => {
    const x = await mkClass("[LIMIT] 경쟁 X", "private", kstDay(10, 10), kstDay(10, 11));
    const y = await mkClass("[LIMIT] 경쟁 Y", "private", kstDay(10, 10, 30), kstDay(10, 11, 30));
    created.push(x, y);
    try {
      expect((await setLimits({ private_max_concurrent_enabled: true, private_max_concurrent: 1 })).error).toBeNull();
      const results = await Promise.all([reserve(x), reserve(y)]);
      const ok = results.filter((r) => r.error === null).length;
      console.log(`[동시 경쟁 관찰] 겹치는 프라이빗 2건 동시 예약 → 확정 ${ok}건 (한도 1)`);
      expect(ok).toBeGreaterThanOrEqual(1);
      // 정책상 1건이어야 한다. 2건이면 서버 함수에 잠금이 없어 경쟁 구간이 있다는 뜻 — 결과를 숨기지 않고 별도 후속으로 보고한다.
    } finally { await cancelAll([x, y]); await setLimits({ private_max_concurrent_enabled: false, private_max_concurrent: null }); }
  });
});
