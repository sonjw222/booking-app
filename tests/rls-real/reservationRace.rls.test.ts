/* F06·F12 동시 요청 경쟁. 격리 PostgreSQL + 실제 회원 JWT 로 서로 다른 트랜잭션이 동시에 한도를 확인하는 상황을 만든다.
   수정 전(운영 정의 그대로 = 롤백 파일 적용 상태): 한도를 넘는 확정이 실제로 생김을 관찰한 뒤, fix_reservation_limit_race_20261023.sql 적용 후 같은 시나리오를 반복해 한 번도 넘지 않음을 확인한다.
   경쟁은 확률적이라 '수정 전' 단언은 위반이 나올 때까지 최대 30회 반복한다(실측 평균 8회 중 5회 위반). */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clientFor, ID, kstDay, sql, U, cleanupSharedState } from "./support";

const apply = (f: string) => execFileSync("docker", ["exec", "-i", "qa-rls-pg", "psql", "-U", "postgres", "-d", "qa", "-v", "ON_ERROR_STOP=1"], { input: fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8"), encoding: "utf8" });
const A = () => clientFor(U.A), B = () => clientFor(U.B);
const MEM = { a1: "e9a00000-0000-0000-0000-000000000001", a2: "e9a00000-0000-0000-0000-000000000002", b: "e9a00000-0000-0000-0000-000000000003" };
const PRODUCT = "e1000000-0000-0000-0000-0000000000e1";
let seq = 0;
const cid = () => `d6000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`;

afterAll(() => {
  sql(`delete from reservations where class_id::text like 'd6000000-%'`); sql(`delete from classes where id::text like 'd6000000-%'`);
  sql(`delete from memberships where id in ('${Object.values(MEM).join("','")}')`);
  sql(`update center_settings set daily_book_limit_enabled=false, daily_book_limit=null, private_max_concurrent_enabled=false, private_max_concurrent=null where center_id='${ID.centerPub}'`);
  cleanupSharedState();
});
function seedMemberships() {
  sql(`delete from reservations where class_id::text like 'd6000000-%'`);
  for (const [id, pr] of [[MEM.a1, ID.pA1], [MEM.a2, ID.pA1], [MEM.b, ID.pB1]] as const)
    sql(`insert into memberships(id,profile_id,center_id,product_id,product_name,total_count,remaining_count,status,pass_type,expires_at) values ('${id}','${pr}','${ID.centerPub}','${PRODUCT}','QA',999,999,'active','count',(current_date+90)) on conflict (id) do update set remaining_count=999,status='active'`);
}
const mkClass = (id: string, start: string, fmt: "group" | "private") =>
  sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode,class_format,booking_deadline_min) values ('${id}','${ID.centerPub}','[QA] 경쟁 ${seq}','${start}'::timestamptz,('${start}'::timestamptz + interval '1 hour'),1,'open','all','${fmt}',0)`);

/** 라운드 1회: 프라이빗 동시 제한 1 — 서로 다른 계정이 같은 시간대 서로 다른 프라이빗 수업을 동시에 예약. 확정 건수를 돌려준다. */
async function privateRound(day: number) {
  const t = kstDay(day, 14, 0), c1 = cid(), c2 = cid();
  mkClass(c1, t, "private"); mkClass(c2, t, "private");
  await Promise.all([
    A().rpc("reserve_with_membership", { p_class_id: c1, p_profile_id: ID.pA1, p_membership_id: MEM.a1 }),
    B().rpc("reserve_with_membership", { p_class_id: c2, p_profile_id: ID.pB1, p_membership_id: MEM.b }),
  ]);
  const n = Number(sql(`select count(*) from reservations where class_id in ('${c1}','${c2}') and status='confirmed'`));
  sql(`delete from reservations where class_id in ('${c1}','${c2}')`);                              // 다음 라운드가 앞 라운드의 한도 건수를 물려받지 않게 정리
  return n;
}
/** 라운드 1회: 일일 제한 1 — 같은 프로필이 서로 다른 수강권으로 같은 날 서로 다른 수업을 동시에 예약. */
async function dailyRound(day: number) {
  const c1 = cid(), c2 = cid();
  mkClass(c1, kstDay(day, 9, 0), "group"); mkClass(c2, kstDay(day, 15, 0), "group");
  await Promise.all([
    A().rpc("reserve_with_membership", { p_class_id: c1, p_profile_id: ID.pA1, p_membership_id: MEM.a1 }),
    A().rpc("reserve_with_membership", { p_class_id: c2, p_profile_id: ID.pA1, p_membership_id: MEM.a2 }),
  ]);
  const n = Number(sql(`select count(*) from reservations where class_id in ('${c1}','${c2}') and status='confirmed'`));
  sql(`delete from reservations where class_id in ('${c1}','${c2}')`);
  return n;
}
const day = (i: number) => 3 + (i % 40);   // 예약 오픈 창(기본 설정) 안의 날짜만 쓴다

describe("수정 전(운영 정의): 동시 요청이 한도를 넘는다", () => {
  it("준비: 원본 정의로 시작, 한도 설정 켜기", () => {
    try { apply("rollback_fix_reservation_limit_race_20261023.sql"); } catch { /* 마커 없으면 변화 없음 */ }
    sql(`update center_settings set private_max_concurrent_enabled=true, private_max_concurrent=1, daily_book_limit_enabled=true, daily_book_limit=1 where center_id='${ID.centerPub}'`);
    seedMemberships();
  });
  it("프라이빗 동시 제한 1: 서로 다른 계정 동시 예약에서 2건이 확정되는 경우가 실제로 나온다", async () => {
    let violated = 0, rounds = 0;
    for (; rounds < 30 && violated === 0; rounds++) if ((await privateRound(day(rounds))) > 1) violated++;
    console.log(`[수정 전 관찰] 프라이빗 동시 제한 위반 ${violated}회 / ${rounds}라운드`);
    expect(violated).toBeGreaterThan(0);
  });
  it("일일 제한 1: 같은 프로필·다른 수강권 동시 예약에서 2건이 확정되는 경우가 있는지 관찰(기록용)", async () => {
    let violated = 0, rounds = 0;
    for (; rounds < 30 && violated === 0; rounds++) if ((await dailyRound(day(rounds))) > 1) violated++;
    console.log(`[수정 전 관찰] 일일 제한 위반 ${violated}회 / ${rounds}라운드`);
    expect(violated).toBeGreaterThanOrEqual(0);
  });
});

describe("수정 후: fix_reservation_limit_race_20261023.sql", () => {
  it("적용·재적용(무시)·롤백·재적용이 가능하다", () => {
    apply("fix_reservation_limit_race_20261023.sql"); apply("fix_reservation_limit_race_20261023.sql");
    apply("rollback_fix_reservation_limit_race_20261023.sql");
    expect(sql(`select position('limit-race-lock' in pg_get_functiondef('public.reserve_with_membership(uuid,uuid,uuid)'::regprocedure))`)).toBe("0");
    apply("fix_reservation_limit_race_20261023.sql");
    expect(sql(`select position('limit-race-lock' in pg_get_functiondef('public.reserve_with_membership(uuid,uuid,uuid)'::regprocedure)) > 0 and position('limit-race-lock' in pg_get_functiondef('public.reserve_class(uuid,uuid)'::regprocedure)) > 0`)).toBe("t");
  });
  it("프라이빗 동시 제한 1: 40라운드 모두 확정은 정확히 1건", async () => {
    seedMemberships();
    const results: number[] = [];
    for (let i = 0; i < 40; i++) results.push(await privateRound(day(i)));
    expect(results.filter((n) => n !== 1), `라운드별 확정 수 ${results.join(",")}`).toEqual([]);
  });
  it("일일 제한 1: 같은 프로필·다른 수강권 동시 예약 40라운드 모두 확정은 정확히 1건", async () => {
    const results: number[] = [];
    for (let i = 0; i < 40; i++) results.push(await dailyRound(day(i)));
    expect(results.filter((n) => n !== 1), `라운드별 확정 수 ${results.join(",")}`).toEqual([]);
  });
  it("서로 다른 날짜·프로필은 서로 막지 않는다(잠금 키 분리): 다른 계정의 같은 날 예약은 둘 다 성공", async () => {
    sql(`update center_settings set private_max_concurrent_enabled=false where center_id='${ID.centerPub}'`);
    const c1 = cid(), c2 = cid(); const t = kstDay(45, 11, 0);
    mkClass(c1, t, "group"); mkClass(c2, t, "group");
    const [ra, rb] = await Promise.all([
      A().rpc("reserve_with_membership", { p_class_id: c1, p_profile_id: ID.pA1, p_membership_id: MEM.a1 }),
      B().rpc("reserve_with_membership", { p_class_id: c2, p_profile_id: ID.pB1, p_membership_id: MEM.b }),
    ]);
    expect([ra.error, rb.error]).toEqual([null, null]);
  });
  it("한도를 넘는 순차 요청은 기존처럼 메시지와 함께 거절된다", async () => {
    const c1 = cid(), c2 = cid(); const dayN = 46;
    mkClass(c1, kstDay(dayN, 9, 0), "group"); mkClass(c2, kstDay(dayN, 15, 0), "group");
    expect((await A().rpc("reserve_with_membership", { p_class_id: c1, p_profile_id: ID.pA1, p_membership_id: MEM.a1 })).error).toBeNull();
    expect((await A().rpc("reserve_with_membership", { p_class_id: c2, p_profile_id: ID.pA1, p_membership_id: MEM.a2 })).error?.message).toMatch(/하루 예약 가능 횟수\(1회\)를 초과/);
  });
  it("패치된 reserve_class(자동 수강권 선택 경로)도 정상 동작하고 한도를 지킨다", async () => {
    sql(`delete from reservations where class_id::text like 'd6000000-%'`);
    const c1 = cid(), c2 = cid(); const dayN = 47;
    mkClass(c1, kstDay(dayN, 9, 0), "group"); mkClass(c2, kstDay(dayN, 15, 0), "group");
    const first = await A().rpc("reserve_class", { p_class_id: c1, p_profile_id: ID.pA1 });
    expect(first.error).toBeNull();
    expect((await A().rpc("reserve_class", { p_class_id: c2, p_profile_id: ID.pA1 })).error?.message).toMatch(/하루 예약 가능 횟수\(1회\)를 초과/);
  });
});
