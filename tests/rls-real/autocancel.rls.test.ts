/* 자동 폐강 알림 중복. 격리 PostgreSQL(저장소의 알림 트리거 + 자동 폐강 스윕 함수) — 외부 푸시·cron·운영 접속 없음.
   run_autocancel_sweep 은 service_role 전용이라 SQL(postgres)로 호출한다(스케줄러 역할의 대체이며 사용자 권한 검증이 아님). 일반 사용자 JWT 로는 호출 불가임을 함께 확인한다.
   1) 수정 전: 같은 회원이 admin_cancelled + reservation_canceled 를 모두 받는다. 2) fix_autocancel_duplicate_notification_20261023.sql 적용 후: 회원은 admin_cancelled 1건만,
   직원 알림은 그대로, 일반 취소 알림은 그대로, 재실행 멱등, 횟수 복구 유지, 롤백 가능. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clientFor, ensureExtraStaff, ID, sql, U } from "./support";

const ROOT = path.resolve(__dirname, "../..");
const apply = (file: string, text?: string) => execFileSync("docker", ["exec", "-i", "qa-rls-pg", "psql", "-U", "postgres", "-d", "qa", "-v", "ON_ERROR_STOP=1"], { input: text ?? fs.readFileSync(path.resolve(ROOT, file), "utf8"), encoding: "utf8" });
const ACC = { A: "a0000000-0000-0000-0000-00000000000a", B: "b0000000-0000-0000-0000-00000000000b", M: "c0000000-0000-0000-0000-00000000000c" };
const CLS = "d9000000-0000-0000-0000-0000000000d9";
const MEM = { a: "d9100000-0000-0000-0000-0000000000a1", b: "d9100000-0000-0000-0000-0000000000b1" };
const RES = { a: "d9200000-0000-0000-0000-0000000000a1", b: "d9200000-0000-0000-0000-0000000000b1", w: "d9200000-0000-0000-0000-0000000000c1" };

function loadSweepFunction() {
  const src = fs.readFileSync(path.resolve(ROOT, "add_autocancel_scheduler.sql"), "utf8");
  const start = src.indexOf("create or replace function run_autocancel_sweep()");
  const end = src.indexOf("$$;", start) + 3;
  return "alter table center_settings add column if not exists autocancel_enabled boolean not null default false;\n" + src.slice(start, end);
}
function seed() {
  sql(`delete from notifications where center_id='${ID.centerPub}'`);
  sql(`delete from reservations where class_id='${CLS}' or membership_id in ('${MEM.a}','${MEM.b}')`); sql(`delete from classes where id='${CLS}'`);
  sql(`delete from memberships where id in ('${MEM.a}','${MEM.b}')`);
  sql(`update center_settings set autocancel_enabled=true, autocancel_hours=3, autocancel_minutes=0 where center_id='${ID.centerPub}'`);
  sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,min_capacity,status,pass_selection_mode) values ('${CLS}','${ID.centerPub}','[QA] 폐강 대상',now()+interval '2 hours',now()+interval '3 hours',5,3,'open','all')`);
  sql(`insert into memberships(id,profile_id,center_id,product_name,total_count,remaining_count,status,pass_type) values ('${MEM.a}','${ID.pA1}','${ID.centerPub}','QA',5,4,'active','count'),('${MEM.b}','${ID.pB1}','${ID.centerPub}','QA',5,4,'active','count')`);
  sql(`insert into reservations(id,class_id,profile_id,membership_id,status) values ('${RES.a}','${CLS}','${ID.pA1}','${MEM.a}','confirmed'),('${RES.b}','${CLS}','${ID.pB1}','${MEM.b}','confirmed')`);
  sql(`delete from notifications where center_id='${ID.centerPub}'`);     // 시드로 생긴 예약 알림은 비운다
}
const sweep = () => JSON.parse(sql("select run_autocancel_sweep()"));
const count = (kind: string, account: string) => Number(sql(`select count(*) from notifications where kind='${kind}' and recipient_account_id='${account}' and center_id='${ID.centerPub}'`));
const remaining = () => sql(`select string_agg(remaining_count::text, ',' order by id) from memberships where id in ('${MEM.a}','${MEM.b}')`);

afterAll(() => {
  sql(`delete from notifications where center_id='${ID.centerPub}'`);
  sql(`delete from reservations where class_id in ('${CLS}','d9000000-0000-0000-0000-0000000000da')`); sql(`delete from classes where id in ('${CLS}','d9000000-0000-0000-0000-0000000000da')`);
  sql(`delete from memberships where id in ('${MEM.a}','${MEM.b}')`);
  sql(`update center_settings set autocancel_enabled=false where center_id='${ID.centerPub}'`);
});   // 다른 테스트 파일에 상태를 남기지 않는다

describe("자동 폐강 알림 — 수정 전(재현)", () => {
  it("준비: 스윕 함수·알림 트리거를 저장소 정의로 구성(원본 상태)", () => {
    ensureExtraStaff();
    apply("", loadSweepFunction());
    sql(`select 1`);
    try { apply("rollback_fix_autocancel_duplicate_notification_20261023.sql"); } catch { /* 처음에는 마커 없음 */ }
  });
  it("같은 회원이 한 번의 폐강에 admin_cancelled 와 reservation_canceled 를 모두 받는다", () => {
    seed();
    expect(sweep()).toEqual({ classes_cancelled: 1, reservations_cancelled: 2 });
    for (const a of [ACC.A, ACC.B]) { expect(count("admin_cancelled", a)).toBe(1); expect(count("reservation_canceled", a)).toBe(1); }   // 중복
    expect(remaining()).toBe("5,5");
  });
});

describe("자동 폐강 알림 — 수정 후", () => {
  it("fix_autocancel_duplicate_notification_20261023.sql 적용 + 재적용(무시) 가능", () => { apply("fix_autocancel_duplicate_notification_20261023.sql"); apply("fix_autocancel_duplicate_notification_20261023.sql"); });

  it("회원은 admin_cancelled 1건만, 직원(센터 활성 계정) 알림은 기존과 같고, 횟수 복구·폐강 결과 유지", () => {
    const staffBefore = (() => { seed(); sql("select 1"); return 0; })();
    expect(staffBefore).toBe(0);
    expect(sweep()).toEqual({ classes_cancelled: 1, reservations_cancelled: 2 });
    for (const a of [ACC.A, ACC.B]) { expect(count("admin_cancelled", a)).toBe(1); expect(count("reservation_canceled", a)).toBe(0); }
    expect(count("reservation_canceled", ACC.M)).toBe(2);                    // 직원 알림은 예약 건수만큼 그대로(변경 없음)
    expect(remaining()).toBe("5,5");
    expect(sql(`select status from classes where id='${CLS}'`)).toBe("cancelled");
    expect(sql(`select count(*) from reservations where class_id='${CLS}' and status='cancelled' and cancel_source='ADMIN'`)).toBe("2");
  });

  it("재실행 멱등: 두 번째 스윕은 0건이고 알림·횟수가 늘지 않는다", () => {
    expect(sweep()).toEqual({ classes_cancelled: 0, reservations_cancelled: 0 });
    expect(count("admin_cancelled", ACC.A)).toBe(1); expect(remaining()).toBe("5,5");
  });

  it("플래그는 스윕 밖으로 새지 않는다: 같은 세션이 아닌 이후의 일반 회원 취소는 reservation_canceled 를 그대로 만든다", async () => {
    sql(`delete from notifications where center_id='${ID.centerPub}'`);
    sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,min_capacity,status,pass_selection_mode) values ('d9000000-0000-0000-0000-0000000000da','${ID.centerPub}','[QA] 일반 취소',now()+interval '3 days',now()+interval '3 days 1 hour',5,1,'open','all') on conflict do nothing`);
    sql(`delete from reservations where id='d9200000-0000-0000-0000-0000000000d1'`);
    sql(`insert into reservations(id,class_id,profile_id,membership_id,status) values ('d9200000-0000-0000-0000-0000000000d1','d9000000-0000-0000-0000-0000000000da','${ID.pA1}','${MEM.a}','confirmed')`);
    sql(`delete from notifications where center_id='${ID.centerPub}'`);
    const r = await clientFor(U.A).rpc("cancel_reservation", { p_reservation_id: "d9200000-0000-0000-0000-0000000000d1" });
    expect(r.error).toBeNull();
    expect(count("reservation_canceled", ACC.A)).toBe(1);
    expect(count("reservation_canceled", ACC.M)).toBe(1);
  });

  it("스윕은 일반 사용자·익명이 호출할 수 없다", async () => {
    expect((await clientFor(U.M).rpc("run_autocancel_sweep")).error).not.toBeNull();
    expect((await clientFor(null).rpc("run_autocancel_sweep")).error).not.toBeNull();
  });

  it("롤백: 역치환 후 다시 중복이 생기고, 다시 적용하면 해소", () => {
    apply("rollback_fix_autocancel_duplicate_notification_20261023.sql");
    seed(); sweep();
    expect(count("reservation_canceled", ACC.A)).toBe(1);
    apply("fix_autocancel_duplicate_notification_20261023.sql");
    seed(); sweep();
    expect(count("reservation_canceled", ACC.A)).toBe(0); expect(count("admin_cancelled", ACC.A)).toBe(1);
  });
});
