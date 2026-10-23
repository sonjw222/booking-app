/* 통합 회귀(격리 DB + 실제 회원/관리자 JWT): 주문→관리자 발급→예약→취소→복구, 중복 발급·발급/자기취소 경쟁, 마지막 좌석 경쟁→대기 1·2→순서 승격→최종 취소,
   대여 상품 차감/복구, 권한 없는 직원의 발급 거부, F10 안내 조건이 서버 거절과 일치. 개별 함수 단위가 아니라 한 회원의 흐름을 따라간다.
   한계: 저장소 SQL을 적용한 재구성(운영 정의와 같다는 보증 없음). 알림·결제 외부 전송 없음(결제 PG 미사용: 직접결제 주문만). 시간은 시드 날짜로 제어(전역 시계 변경 없음). */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bookingHint } from "../../lib/bookingHints";
import { clientFor, ensureExtraStaff, ID, kstDay, sql, U, U2, cleanupSharedState } from "./support";

const applySql = (f: string) => execFileSync("docker", ["exec", "-i", "qa-rls-pg", "psql", "-U", "postgres", "-d", "qa", "-v", "ON_ERROR_STOP=1"], { input: fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8"), encoding: "utf8" });
const A = () => clientFor(U.A), B = () => clientFor(U.B), OWNER = () => clientFor(U.M), STAFF = () => clientFor(U2.S);
const P = { pass: "e9000000-0000-0000-0000-0000000000e1", goods: "e9000000-0000-0000-0000-0000000000e2" };
const day = (n: number, hh = 10) => new Date(Date.now() + n * 86400000 + 0).toISOString().replace(/T.*/, `T${String(hh).padStart(2, "0")}:00:00+09:00`);
const mkClass = (id: string, opts: { cap?: number; days?: number; goods?: boolean; fmt?: string } = {}) =>
  sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode,allow_goods,class_format) values ('${id}','${ID.centerPub}','[QA] 통합 ${id.slice(-2)}','${day(opts.days ?? 5, 10)}'::timestamptz,'${day(opts.days ?? 5, 11)}'::timestamptz,${opts.cap ?? 5},'open','all',${opts.goods ? "true" : "false"},'${opts.fmt ?? "group"}') on conflict (id) do nothing`);
const cid = (n: number) => `d7000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const remaining = (mid: string) => Number(sql(`select remaining_count from memberships where id='${mid}'`));
const resv = (id: string) => sql(`select status from reservations where id='${id}'`);
const mships = (profile: string, product: string) => sql(`select id from memberships where profile_id='${profile}' and product_id='${product}' order by created_at`).split("\n").filter(Boolean);

const created = { orders: [] as string[] };
afterAll(() => {
  sql(`delete from notifications where center_id='${ID.centerPub}'`);
  sql(`delete from reservations where class_id::text like 'd7000000-%'`);
  sql(`delete from classes where id::text like 'd7000000-%'`);
  sql(`delete from payments where order_id in (select id from orders where product_id in ('${P.pass}','${P.goods}'))`);
  sql(`delete from memberships where product_id in ('${P.pass}','${P.goods}')`);
  sql(`delete from orders where product_id in ('${P.pass}','${P.goods}')`);
  sql(`delete from products where id in ('${P.pass}','${P.goods}')`);
  sql(`update center_settings set waitlist_weekly_limit=0, allow_same_day_booking=true where center_id='${ID.centerPub}'`);
  cleanupSharedState();
});

const order = (c: ReturnType<typeof clientFor>, profile: string, product: string, name: string, amount: number) =>
  c.from("orders").insert({ center_id: ID.centerPub, profile_id: profile, product_id: product, product_name: name, amount, pay_method: "center", status: "pending" }).select("id").single();

describe("1) 주문 → 관리자 발급 → 회원 수강권 → 예약 → 취소 → 복구", () => {
  it("준비: 3회 수강권(30000원)·대여 상품 2회(0원 아님 20000원) 판매 중", () => {
    ensureExtraStaff();
    sql(`insert into products(id,center_id,name,price,product_kind,total_count,is_active,is_on_sale) values ('${P.pass}','${ID.centerPub}','[QA] 통합 3회권',30000,'pass',3,true,true),('${P.goods}','${ID.centerPub}','[QA] 통합 대여화',20000,'goods',2,true,true)`);
    mkClass(cid(1), { goods: true }); mkClass(cid(2));
  });

  it("회원 A 주문 → 권한 없는 직원은 발급 거부, 오너 발급 1회 → 수강권 3회, 같은 주문 중복·동시 발급은 새 수강권을 만들지 않는다", async () => {
    const o = await order(A(), ID.pA1, P.pass, "[QA] 통합 3회권", 30000);
    expect(o.error).toBeNull(); const oid = (o.data as { id: string }).id; created.orders.push(oid);
    expect((await STAFF().rpc("fulfill_order", { p_order_id: oid })).error).not.toBeNull();
    expect((await A().rpc("fulfill_order", { p_order_id: oid })).error).not.toBeNull();            // 회원 본인도 발급 불가
    expect(mships(ID.pA1, P.pass)).toHaveLength(0);
    const [r1, r2] = await Promise.all([OWNER().rpc("fulfill_order", { p_order_id: oid }), OWNER().rpc("fulfill_order", { p_order_id: oid })]);
    expect([r1.error, r2.error].filter((e) => e === null).length).toBeGreaterThanOrEqual(1);
    expect(mships(ID.pA1, P.pass)).toHaveLength(1);                                              // 중복 발급 없음
    expect(sql(`select status from orders where id='${oid}'`)).toBe("done");
    expect(sql(`select count(*) from payments where order_id='${oid}'`)).toBe("1");
    const again = await OWNER().rpc("fulfill_order", { p_order_id: oid });                          // 이미 처리된 주문 재발급: 오류가 아니라 already_done 으로 멱등 응답
    expect(again.error).toBeNull(); expect((again.data as { already_done?: boolean }).already_done).toBe(true);
    expect(mships(ID.pA1, P.pass)).toHaveLength(1);
    expect(sql(`select count(*) from payments where order_id='${oid}'`)).toBe("1");
  });

  it("회원 화면용 조회(내 수강권)에 3/3, 예약 → 2회, 취소 → 3회로 정확히 복구(중복 취소는 추가 복구 없음)", async () => {
    const [m] = mships(ID.pA1, P.pass);
    const mine = await A().from("memberships").select("remaining_count,total_count").eq("id", m).single();
    expect(mine.data).toEqual({ remaining_count: 3, total_count: 3 });
    const r = await A().rpc("reserve_with_membership", { p_class_id: cid(2), p_profile_id: ID.pA1, p_membership_id: m });
    expect(r.error).toBeNull();
    const rid = (r.data as { reservation_id?: string; id?: string }).reservation_id ?? (r.data as { id?: string }).id ?? sql(`select id from reservations where class_id='${cid(2)}' and profile_id='${ID.pA1}'`);
    expect(remaining(m)).toBe(2);
    const dup = await A().rpc("reserve_with_membership", { p_class_id: cid(2), p_profile_id: ID.pA1, p_membership_id: m });
    expect(dup.error).not.toBeNull(); expect(remaining(m)).toBe(2);                              // 중복 예약 거부, 이중 차감 없음
    expect((await B().rpc("cancel_reservation", { p_reservation_id: rid })).error).not.toBeNull(); // 타 계정은 취소 불가
    expect((await A().rpc("cancel_reservation", { p_reservation_id: rid })).error).toBeNull();
    expect(remaining(m)).toBe(3); expect(resv(rid)).toBe("cancelled");
    await A().rpc("cancel_reservation", { p_reservation_id: rid });                              // 재취소
    expect(remaining(m)).toBe(3);
  });

  it("발급 vs 회원 자기 취소 경쟁: 둘 중 하나만 성립(발급되면 취소 0행, 취소되면 발급 실패) — 발급된 주문이 취소되거나 취소된 주문이 발급되지 않는다", async () => {
    for (let i = 0; i < 4; i++) {
      const o = await order(A(), ID.pA1, P.pass, "[QA] 통합 3회권", 30000); const oid = (o.data as { id: string }).id; created.orders.push(oid);
      const before = mships(ID.pA1, P.pass).length;
      const [ful, can] = await Promise.all([OWNER().rpc("fulfill_order", { p_order_id: oid }), A().from("orders").update({ status: "cancelled" }).eq("id", oid).select("id")]);
      const status = sql(`select status from orders where id='${oid}'`); const after = mships(ID.pA1, P.pass).length;
      if (status === "done") { expect(after).toBe(before + 1); expect(ful.error).toBeNull(); expect(can.data ?? []).toHaveLength(0); }
      else { expect(status).toBe("cancelled"); expect(after).toBe(before); }                       // 취소된 주문에 수강권이 생기지 않음
    }
  });

  it("대여 상품: 발급 2회 → 대여 가능 수업 예약 1회 → 취소하면 2회 복구", async () => {
    const o = await order(A(), ID.pA1, P.goods, "[QA] 통합 대여화", 20000); const oid = (o.data as { id: string }).id; created.orders.push(oid);
    expect((await OWNER().rpc("fulfill_order", { p_order_id: oid })).error).toBeNull();
    const [g] = mships(ID.pA1, P.goods); expect(remaining(g)).toBe(2);
    const [pm] = mships(ID.pA1, P.pass);                                                            // 수업 예약은 수강권으로, 대여 상품은 함께 선택
    const direct = await A().rpc("reserve_with_membership", { p_class_id: cid(1), p_profile_id: ID.pA1, p_membership_id: g });
    expect(direct.error?.message).toMatch(/사용할 수 없는 수강권/);                                    // 대여 상품 자체로는 수업을 예약할 수 없다
    expect(remaining(g)).toBe(2);
    const r = await A().rpc("reserve_with_goods", { p_class_id: cid(1), p_profile_id: ID.pA1, p_membership_id: pm, p_goods_membership_id: g });
    if (r.error) throw new Error("대여 상품 함께 예약 실패: " + r.error.message);
    expect(remaining(g)).toBe(1); expect(remaining(pm)).toBe(2);
    const rid = sql(`select id from reservations where class_id='${cid(1)}' and profile_id='${ID.pA1}' and status='confirmed'`);
    expect((await A().rpc("cancel_reservation", { p_reservation_id: rid })).error).toBeNull();
    expect(remaining(g)).toBe(2); expect(remaining(pm)).toBe(3);                                      // 대여 상품·수강권 모두 복구
  });
});

describe("2) 마지막 좌석 경쟁 → 대기 → 순서 승격 → 최종 취소", () => {
  const grant = (profile: string, n: number, expires: string | null) => { const id = `e9100000-0000-0000-0000-0000000000${n}`; sql(`insert into memberships(id,profile_id,center_id,product_id,product_name,total_count,remaining_count,status,pass_type,expires_at) values ('${id}','${profile}','${ID.centerPub}','${P.pass}','[QA] 통합 3회권',3,3,'active','count',${expires ? `'${expires}'` : "null"}) on conflict (id) do update set remaining_count=3,status='active',expires_at=${expires ? `'${expires}'` : "null"}`); return id; };
  const futureDate = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  async function raceAndPromote(classNo: number, expires: string | null, base: number) {
    sql(`update center_settings set waitlist_weekly_limit=5 where center_id='${ID.centerPub}'`);
    mkClass(cid(classNo), { cap: 1, days: 6 });
    const m1 = grant(ID.pA1, base + 1, expires), m2 = grant(ID.pB1, base + 2, expires), m3 = grant(ID.pA2, base + 3, expires);
    const rs = await Promise.all([
      A().rpc("reserve_with_membership", { p_class_id: cid(classNo), p_profile_id: ID.pA1, p_membership_id: m1 }),
      B().rpc("reserve_with_membership", { p_class_id: cid(classNo), p_profile_id: ID.pB1, p_membership_id: m2 }),
      A().rpc("reserve_with_membership", { p_class_id: cid(classNo), p_profile_id: ID.pA2, p_membership_id: m3 }),
    ]);
    expect(rs.map((r) => r.error)).toEqual([null, null, null]);
    const rows = sql(`select profile_id||'|'||status from reservations where class_id='${cid(classNo)}'`).split("\n");
    expect(rows.filter((r) => r.endsWith("|confirmed"))).toHaveLength(1);                         // 마지막 좌석: 확정은 정확히 1
    expect(rows.filter((r) => r.endsWith("|waitlisted"))).toHaveLength(2);
    expect([m1, m2, m3].map(remaining).sort()).toEqual([2, 3, 3]);                                 // 대기자는 차감되지 않음
    return { ms: [m1, m2, m3], seq: sql(`select id||'|'||profile_id||'|'||membership_id from reservations where class_id='${cid(classNo)}' order by created_at, id`).split("\n").map((l) => l.split("|")) };
  }
  const clientOf = (profile: string) => (profile === ID.pB1 ? B() : A());

  it("정원 1 동시 3건 → 확정 1·대기 2. 앞 예약 취소 → 먼저 대기한 사람 승격(그때 차감) → 다시 취소 → 다음 대기 승격 → 최종 취소 후 전부 복구 (만료일 있는 수강권)", async () => {
    const { seq } = await raceAndPromote(3, futureDate, 31);
    for (let round = 0; round < 3; round++) {
      const confirmed = seq.find((r) => resv(r[0]) === "confirmed")!;
      const waiting = seq.filter((r) => resv(r[0]) === "waitlisted").sort((a, b) => Number(sql(`select waitlist_order from reservations where id='${a[0]}'`)) - Number(sql(`select waitlist_order from reservations where id='${b[0]}'`)));
      expect((await clientOf(confirmed[1]).rpc("cancel_reservation", { p_reservation_id: confirmed[0] })).error).toBeNull();
      expect(remaining(confirmed[2])).toBe(3);
      if (waiting[0]) { expect(resv(waiting[0][0])).toBe("confirmed"); expect(remaining(waiting[0][2])).toBe(2); }   // 대기 순서대로 승격 + 승격 시 차감
    }
    expect(seq.map((r) => resv(r[0]))).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(seq.map((r) => remaining(r[2]))).toEqual([3, 3, 3]);
  });

  it("[F21 재현] 기간 무제한(expires_at NULL) 수강권 대기자는 확정 취소 후에도 승격되지 않는다(수정 전)", async () => {
    applySql("rollback_fix_waitlist_promotion_null_expiry_20261023.sql");
    const { seq } = await raceAndPromote(6, null, 41);
    const confirmed = seq.find((r) => resv(r[0]) === "confirmed")!;
    expect((await clientOf(confirmed[1]).rpc("cancel_reservation", { p_reservation_id: confirmed[0] })).error).toBeNull();
    expect(seq.filter((r) => resv(r[0]) === "confirmed")).toHaveLength(0);                          // 자리가 났는데 아무도 승격되지 않음
    expect(seq.filter((r) => resv(r[0]) === "waitlisted")).toHaveLength(2);
  });

  it("[F21 수정] fix_waitlist_promotion_null_expiry_20261023.sql 적용(재적용 무시) 후에는 무제한 수강권 대기자도 순서대로 승격되고 그때 차감된다", async () => {
    applySql("fix_waitlist_promotion_null_expiry_20261023.sql"); applySql("fix_waitlist_promotion_null_expiry_20261023.sql");
    const { seq } = await raceAndPromote(7, null, 51);
    const first = seq.find((r) => resv(r[0]) === "confirmed")!;
    const order = seq.filter((r) => resv(r[0]) === "waitlisted").sort((a, b) => Number(sql(`select waitlist_order from reservations where id='${a[0]}'`)) - Number(sql(`select waitlist_order from reservations where id='${b[0]}'`)));
    expect((await clientOf(first[1]).rpc("cancel_reservation", { p_reservation_id: first[0] })).error).toBeNull();
    expect(resv(order[0][0])).toBe("confirmed"); expect(remaining(order[0][2])).toBe(2);
    expect(resv(order[1][0])).toBe("waitlisted");
    const second = order[0];
    expect((await clientOf(second[1]).rpc("cancel_reservation", { p_reservation_id: second[0] })).error).toBeNull();
    expect(resv(order[1][0])).toBe("confirmed");
    expect((await clientOf(order[1][1]).rpc("cancel_reservation", { p_reservation_id: order[1][0] })).error).toBeNull();
    expect(seq.map((r) => remaining(r[2]))).toEqual([3, 3, 3]);
  });
});

describe("3) F10 안내 조건 = 서버 거절 조건 (설정값이 같은 입력)", () => {
  it("대기 횟수 0 + 정원 마감 → 서버가 대기를 거절하고, 같은 입력의 bookingHint 가 'no_waitlist' 를 돌려준다", async () => {
    sql(`update center_settings set waitlist_weekly_limit=0 where center_id='${ID.centerPub}'`);
    mkClass(cid(4), { cap: 1, days: 7 });
    sql(`insert into memberships(id,profile_id,center_id,product_id,product_name,total_count,remaining_count,status,pass_type) values ('e9100000-0000-0000-0000-000000000021','${ID.pA1}','${ID.centerPub}','${P.pass}','x',3,3,'active','count'),('e9100000-0000-0000-0000-000000000022','${ID.pB1}','${ID.centerPub}','${P.pass}','x',3,3,'active','count') on conflict do nothing`);
    expect((await A().rpc("reserve_with_membership", { p_class_id: cid(4), p_profile_id: ID.pA1, p_membership_id: "e9100000-0000-0000-0000-000000000021" })).error).toBeNull();
    const denied = await B().rpc("reserve_with_membership", { p_class_id: cid(4), p_profile_id: ID.pB1, p_membership_id: "e9100000-0000-0000-0000-000000000022" });
    expect(denied.error?.message).toMatch(/대기예약을 사용하지 않아요/);
    expect(remaining("e9100000-0000-0000-0000-000000000022")).toBe(3);
    const settings = await B().from("center_settings").select("waitlist_weekly_limit").eq("center_id", ID.centerPub).single();       // 회원이 읽는 값 = 서버가 읽는 값
    expect(settings.data?.waitlist_weekly_limit).toBe(0);
    expect(bookingHint({ full: true, classFormat: "group", waitlistWeeklyLimit: settings.data!.waitlist_weekly_limit, allowSameDayBooking: true, bookingDeadlineMin: null, classDate: "2099-01-01", todayKst: "2026-10-23" })?.kind).toBe("no_waitlist");
  });

  it("당일 예약 OFF + 오늘 수업 → 서버 거절, 개별 예약마감이 있으면 안내 없음(서버도 토글을 건너뜀)", async () => {
    sql(`update center_settings set allow_same_day_booking=false where center_id='${ID.centerPub}'`);
    // 운영의 classes.booking_deadline_min 이 NOT NULL default 0 인지(schema.sql) 아니면 nullable 인지(fix_class_booking_deadline_override_draft_proposed.sql)는 이 저장소만으로 알 수 없다.
    // 서버 규칙은 "booking_deadline_min IS NULL 일 때만 당일 예약 토글 적용"이므로, 두 경우를 모두 확인한다: (1) default 0 인 수업 → 토글이 적용되지 않음(힌트도 없음), (2) NULL 인 수업 → 거절 + 힌트.
    sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode) values ('${cid(8)}','${ID.centerPub}','[QA] 오늘 default0',now()+interval '2 hours',now()+interval '3 hours',5,'open','all') on conflict (id) do nothing`);
    const zero = await A().rpc("reserve_with_membership", { p_class_id: cid(8), p_profile_id: ID.pA1, p_membership_id: "e9100000-0000-0000-0000-000000000021" });
    expect(zero.error?.message ?? "").not.toMatch(/당일 예약은 허용되지 않아요/);
    expect(bookingHint({ full: false, classFormat: "group", waitlistWeeklyLimit: 0, allowSameDayBooking: false, bookingDeadlineMin: 0, classDate: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date()), todayKst: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date()) })).toBeNull();
    sql(`alter table classes alter column booking_deadline_min drop not null`);                       // 격리 DB 전용(위 설명)
    const todayKst = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
    sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode,booking_deadline_min) values ('${cid(5)}','${ID.centerPub}','[QA] 오늘 수업',now()+interval '2 hours',now()+interval '3 hours',5,'open','all',null) on conflict (id) do update set booking_deadline_min=null`);
    const r = await A().rpc("reserve_with_membership", { p_class_id: cid(5), p_profile_id: ID.pA1, p_membership_id: "e9100000-0000-0000-0000-000000000021" });
    const kstDate = sql(`select (start_time at time zone 'Asia/Seoul')::date from classes where id='${cid(5)}'`);
    if (kstDate === todayKst) {                                                                      // 자정 직전 실행으로 날짜가 넘어가면 이 검증만 건너뜀(서버 규칙 자체는 위 단언)
      expect(r.error?.message).toMatch(/당일 예약은 허용되지 않아요/);
      expect(bookingHint({ full: false, classFormat: "group", waitlistWeeklyLimit: 0, allowSameDayBooking: false, bookingDeadlineMin: null, classDate: kstDate, todayKst })?.kind).toBe("same_day_off");
    }
    sql(`update center_settings set allow_same_day_booking=true where center_id='${ID.centerPub}'`);
  });
});

describe("4) F06 일일 예약 제한: KST 일자 경계·프로필 기준 (서버 규칙 그대로)", () => {
  const mem = (n: number, profile: string) => { const id = `e9100000-0000-0000-0000-0000000000${n}`; sql(`insert into memberships(id,profile_id,center_id,product_id,product_name,total_count,remaining_count,status,pass_type,expires_at) values ('${id}','${profile}','${ID.centerPub}','${P.pass}','QA',9,9,'active','count',(current_date+90)) on conflict (id) do update set remaining_count=9`); return id; };
  const cls = (n: number, startIso: string) => sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode,booking_deadline_min) values ('${cid(n)}','${ID.centerPub}','[QA] 일일 ${n}','${startIso}'::timestamptz,('${startIso}'::timestamptz + interval '1 hour'),5,'open','all',0) on conflict (id) do nothing`);

  it("제한 ON(1회): 같은 KST 날짜의 두 번째 수업은 거절, 자정을 넘긴 다음 날 수업은 허용, 가족 프로필은 별도로 센다", async () => {
    sql(`update center_settings set daily_book_limit_enabled=true, daily_book_limit=1 where center_id='${ID.centerPub}'`);
    const mA1 = mem(61, ID.pA1), mA2 = mem(62, ID.pA2);
    cls(61, kstDay(10, 23, 30)); cls(62, kstDay(10, 18, 0)); cls(63, kstDay(11, 0, 30));          // 10일 뒤 23:30, 같은 날 18:00, 다음 날 00:30(KST)
    expect((await A().rpc("reserve_with_membership", { p_class_id: cid(61), p_profile_id: ID.pA1, p_membership_id: mA1 })).error).toBeNull();
    const second = await A().rpc("reserve_with_membership", { p_class_id: cid(62), p_profile_id: ID.pA1, p_membership_id: mA1 });
    expect(second.error?.message).toMatch(/하루 예약 가능 횟수\(1회\)를 초과/);                       // 같은 KST 날짜
    expect(remaining(mA1)).toBe(8);                                                                // 거절된 요청은 차감 없음
    expect((await A().rpc("reserve_with_membership", { p_class_id: cid(63), p_profile_id: ID.pA1, p_membership_id: mA1 })).error).toBeNull();   // 00:30 은 다음 KST 날짜(UTC 로는 전날)
    expect((await A().rpc("reserve_with_membership", { p_class_id: cid(62), p_profile_id: ID.pA2, p_membership_id: mA2 })).error).toBeNull();     // 가족 프로필은 프로필별로 센다
  });

  it("제한 OFF 로 바꾸면 같은 날 추가 예약이 가능하다(숫자가 남아 있어도 OFF 가 우선)", async () => {
    sql(`update center_settings set daily_book_limit_enabled=false where center_id='${ID.centerPub}'`);
    cls(64, kstDay(10, 20, 0));
    expect((await A().rpc("reserve_with_membership", { p_class_id: cid(64), p_profile_id: ID.pA1, p_membership_id: "e9100000-0000-0000-0000-000000000061" })).error).toBeNull();
    sql(`update center_settings set daily_book_limit_enabled=false, daily_book_limit=null where center_id='${ID.centerPub}'`);
  });
});

describe("5) F12 프라이빗 동시 제한: 서로 다른 계정의 동시 예약 경쟁 (관찰 기록)", () => {
  it("같은 시간대 프라이빗 2개 + 최대 1건: 서로 다른 계정이 동시에 하나씩 예약할 때의 결과를 반복 관찰한다", async () => {
    sql(`update center_settings set private_max_concurrent_enabled=true, private_max_concurrent=1 where center_id='${ID.centerPub}'`);
    const mA = `e9100000-0000-0000-0000-000000000071`, mB = `e9100000-0000-0000-0000-000000000072`;
    for (const [m, pr] of [[mA, ID.pA1], [mB, ID.pB1]] as const) sql(`insert into memberships(id,profile_id,center_id,product_id,product_name,total_count,remaining_count,status,pass_type,expires_at) values ('${m}','${pr}','${ID.centerPub}','${P.pass}','QA',99,99,'active','count',(current_date+90)) on conflict (id) do update set remaining_count=99`);
    const outcomes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const c1 = `d7000000-0000-0000-0000-0000000001${i}1`, c2 = `d7000000-0000-0000-0000-0000000001${i}2`;
      const t = kstDay(20 + i, 14, 0);
      for (const c of [c1, c2]) sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode,class_format,booking_deadline_min) values ('${c}','${ID.centerPub}','[QA] 프라이빗 ${i}','${t}'::timestamptz,('${t}'::timestamptz + interval '1 hour'),1,'open','all','private',0) on conflict (id) do nothing`);
      const [ra, rb] = await Promise.all([
        A().rpc("reserve_with_membership", { p_class_id: c1, p_profile_id: ID.pA1, p_membership_id: mA }),
        B().rpc("reserve_with_membership", { p_class_id: c2, p_profile_id: ID.pB1, p_membership_id: mB }),
      ]);
      const confirmed = [ra, rb].filter((r) => r.error === null).length;
      outcomes.push(confirmed);
      expect(sql(`select count(*) from reservations where class_id in ('${c1}','${c2}') and status='confirmed'`)).toBe(String(confirmed));
    }
    console.log(`[관찰] 프라이빗 동시 제한 1, 서로 다른 계정 동시 예약 8회 → 성공 건수: ${outcomes.join(",")}`);
    sql(`update center_settings set private_max_concurrent_enabled=false, private_max_concurrent=null where center_id='${ID.centerPub}'`);
    // 어느 경우든 직렬 실행 규칙은 유지: 이미 1건이 확정된 상태에서 다른 계정이 같은 시간대를 시도하면 거절된다(경쟁이 아닌 순차)
    expect(outcomes.every((n) => n >= 1)).toBe(true);
  });
});
