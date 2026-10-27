/*
  accounts INSERT 특권 컬럼 보호(fix_accounts_insert_privileged_columns_20261030.sql) — 실제 PostgreSQL 엔진(PGlite)에서 트리거를 돌려 보는 회귀 시험.
  RLS·Auth 서버는 이 시험 범위 밖이다(그건 scripts/security/accountsInsertGuard.verify.mjs 가 일회용 Supabase 로 확인). 여기서는 "트리거 로직이 의도대로 막고 통과시키는가"를 단언한다.
  보호를 지운 SQL 로도 이 시험이 실패하는지는 scripts/security/accountsInsertGuard.regression.sh 가 ACCOUNTS_GUARD_SQL 로 변조본을 넣어 확인한다.
*/
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const SQL_PATH = process.env.ACCOUNTS_GUARD_SQL ?? path.resolve(__dirname, "../../fix_accounts_insert_privileged_columns_20261030.sql");
const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222", ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VICTIM_ACCOUNT = "99999999-9999-4999-8999-999999999999";

// 기존 UPDATE 가드 3개는 isolated-supabase 베이스라인(운영과 같은 계보)의 정의를 그대로 옮겼다.
const SETUP = `
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table accounts (id uuid primary key default gen_random_uuid(), auth_id uuid unique not null, name text, is_platform_admin boolean not null default false, pg_checkout_override boolean not null default false, merged_into uuid, phone text);
create function is_platform_admin() returns boolean language sql stable security definer as $$ select coalesce((select a.is_platform_admin from accounts a where a.auth_id = auth.uid()), false) $$;
create function enforce_accounts_is_platform_admin_admin_only() returns trigger language plpgsql security definer as $$
begin if new.is_platform_admin is distinct from old.is_platform_admin then if auth.uid() is not null and not is_platform_admin() then raise exception '이 값은 운영자만 변경할 수 있어요'; end if; end if; return new; end; $$;
create trigger trg_accounts_is_platform_admin_admin_only before update on accounts for each row execute function enforce_accounts_is_platform_admin_admin_only();
create function enforce_pg_checkout_override_admin_only() returns trigger language plpgsql security definer as $$
begin if new.pg_checkout_override is distinct from old.pg_checkout_override then if auth.uid() is not null and not is_platform_admin() then raise exception '이 값은 운영자만 변경할 수 있어요'; end if; end if; return new; end; $$;
create trigger trg_accounts_pg_checkout_override_admin_only before update on accounts for each row execute function enforce_pg_checkout_override_admin_only();
create function enforce_accounts_merged_into_via_linking_only() returns trigger language plpgsql security definer as $$
begin if new.merged_into is distinct from old.merged_into then if auth.uid() is not null and coalesce(current_setting('app.allow_merged_into_change', true), 'false') <> 'true' then raise exception 'merged_into는 계정 연동 절차(link_accounts_by_code)를 통해서만 변경할 수 있어요'; end if; end if; return new; end; $$;
create trigger trg_accounts_merged_into_via_linking_only before update on accounts for each row execute function enforce_accounts_merged_into_via_linking_only();
insert into accounts (id, auth_id, name) values ('${VICTIM_ACCOUNT}', '${U2}', 'victim');
insert into accounts (auth_id, name, is_platform_admin) values ('${ADMIN}', 'admin', true);
`;
let db: PGlite;
const as = async (uid: string | null) => { await db.exec(`select set_config('test.uid', '${uid ?? ""}', false)`); };
const rejects = async (sql: string, re: RegExp) => { let err: Error | null = null; try { await db.exec(sql); } catch (e) { err = e as Error; } expect(err, `거부돼야 함: ${sql}`).not.toBeNull(); expect(err!.message).toMatch(re); };
const count = async (authId: string) => Number((await db.query<{ n: number }>(`select count(*)::int n from accounts where auth_id = '${authId}'`)).rows[0].n);

beforeEach(async () => { db = new PGlite(); await db.exec(SETUP); await db.exec(readFileSync(SQL_PATH, "utf8")); await as(null); await db.exec(`delete from accounts where auth_id = '${U1}'`); await as(U1); });

describe("accounts INSERT 특권 컬럼 보호 — 인증된 일반 사용자", () => {
  it("정상 가입(특권 컬럼 미지정 → 기본값)·false 명시는 통과하고 권한은 모두 false", async () => {
    await db.exec(`insert into accounts (auth_id, name) values ('${U1}', '정상')`);
    const r = (await db.query<{ a: boolean; b: boolean; c: string | null }>(`select is_platform_admin a, pg_checkout_override b, merged_into c from accounts where auth_id='${U1}'`)).rows[0];
    expect(r).toEqual({ a: false, b: false, c: null });
    await as(null); await db.exec(`delete from accounts where auth_id='${U1}'`); await as(U1);
    await db.exec(`insert into accounts (auth_id, name, is_platform_admin, pg_checkout_override, merged_into) values ('${U1}', '명시 false', false, false, null)`);
    expect(await count(U1)).toBe(1);
  });
  it("is_platform_admin=true 지정 INSERT 는 거부되고 행이 남지 않는다", async () => {
    await rejects(`insert into accounts (auth_id, name, is_platform_admin) values ('${U1}', 'x', true)`, /운영자만/); expect(await count(U1)).toBe(0);
  });
  it("pg_checkout_override=true 지정 INSERT 는 거부된다", async () => {
    await rejects(`insert into accounts (auth_id, name, pg_checkout_override) values ('${U1}', 'x', true)`, /운영자만/); expect(await count(U1)).toBe(0);
  });
  it("다른 계정을 가리키는 merged_into 지정 INSERT 는 거부된다(계정 사칭 방지)", async () => {
    await rejects(`insert into accounts (auth_id, name, merged_into) values ('${U1}', 'x', '${VICTIM_ACCOUNT}')`, /merged_into/); expect(await count(U1)).toBe(0);
  });
  it("세 값을 함께 지정해도 거부된다", async () => {
    await rejects(`insert into accounts (auth_id, name, is_platform_admin, pg_checkout_override, merged_into) values ('${U1}', 'x', true, true, '${VICTIM_ACCOUNT}')`, /운영자만|merged_into/); expect(await count(U1)).toBe(0);
  });
  it("upsert(신규): 특권 값이 있으면 INSERT 단계에서 거부", async () => {
    for (const col of ["is_platform_admin", "pg_checkout_override"]) await rejects(`insert into accounts (auth_id, name, ${col}) values ('${U1}', 'x', true) on conflict (auth_id) do update set name = excluded.name, ${col} = excluded.${col}`, /운영자만/);
    await rejects(`insert into accounts (auth_id, name, merged_into) values ('${U1}', 'x', '${VICTIM_ACCOUNT}') on conflict (auth_id) do update set merged_into = excluded.merged_into`, /merged_into/);
    expect(await count(U1)).toBe(0);
  });
  it("upsert(기존 행): ON CONFLICT DO UPDATE 로 특권 값을 올리는 것은 기존 UPDATE 가드가 거부하고, 일반 갱신은 통과", async () => {
    await db.exec(`insert into accounts (auth_id, name) values ('${U1}', '정상')`);
    await rejects(`insert into accounts (auth_id, name) values ('${U1}', 'x') on conflict (auth_id) do update set is_platform_admin = true`, /운영자만/);
    await rejects(`insert into accounts (auth_id, name) values ('${U1}', 'x') on conflict (auth_id) do update set merged_into = '${VICTIM_ACCOUNT}'`, /merged_into/);
    await db.exec(`insert into accounts (auth_id, name) values ('${U1}', '이름변경') on conflict (auth_id) do update set name = excluded.name`);
    expect((await db.query<{ name: string }>(`select name from accounts where auth_id='${U1}'`)).rows[0].name).toBe("이름변경");
  });
  it("삭제 후 재생성: 특권 값으로는 거부, 정상 값으로는 통과", async () => {
    await db.exec(`insert into accounts (auth_id, name) values ('${U1}', '정상')`); await db.exec(`delete from accounts where auth_id='${U1}'`);
    await rejects(`insert into accounts (auth_id, name, is_platform_admin) values ('${U1}', 'x', true)`, /운영자만/);
    await db.exec(`insert into accounts (auth_id, name) values ('${U1}', '재생성')`); expect(await count(U1)).toBe(1);
  });
  it("계정 연동 절차(app.allow_merged_into_change=true, link_accounts_by_code 가 UPDATE 로 사용)는 그대로 동작", async () => {
    await db.exec(`insert into accounts (auth_id, name) values ('${U1}', '합쳐질 계정')`);
    await db.exec(`select set_config('app.allow_merged_into_change', 'true', false)`);
    await db.exec(`update accounts set merged_into = '${VICTIM_ACCOUNT}' where auth_id = '${U1}'`);
    expect((await db.query<{ c: string }>(`select merged_into c from accounts where auth_id='${U1}'`)).rows[0].c).toBe(VICTIM_ACCOUNT);
  });
});

describe("승인된 서버·운영자 경로는 유지", () => {
  it("서버(service_role)·SQL Editor(auth.uid() is null)는 특권 값으로도 생성할 수 있다", async () => {
    await as(null);
    await db.exec(`insert into accounts (auth_id, name, is_platform_admin, pg_checkout_override, merged_into) values ('${U1}', '서버 생성', true, true, '${VICTIM_ACCOUNT}')`);
    expect(await count(U1)).toBe(1);
  });
  it("플랫폼 관리자는 is_platform_admin·pg_checkout_override 지정 가능, merged_into 는 연동 절차 예외가 있을 때만(UPDATE 가드와 같은 기준)", async () => {
    await as(ADMIN);
    await db.exec(`insert into accounts (auth_id, name, is_platform_admin, pg_checkout_override) values ('${U1}', '관리자가 만든', true, true)`); expect(await count(U1)).toBe(1);
    await db.exec(`delete from accounts where auth_id='${U1}'`);
    await rejects(`insert into accounts (auth_id, name, merged_into) values ('${U1}', 'x', '${VICTIM_ACCOUNT}')`, /merged_into/);
    await db.exec(`select set_config('app.allow_merged_into_change', 'true', false)`);
    await db.exec(`insert into accounts (auth_id, name, merged_into) values ('${U1}', '연동 절차', '${VICTIM_ACCOUNT}')`); expect(await count(U1)).toBe(1);
  });
});

describe("파일 계약", () => {
  it("BEFORE INSERT 행 트리거 1개, SECURITY DEFINER·search_path 고정, 단일 트랜잭션, 기존 데이터를 바꾸는 문장 없음", () => {
    const src = readFileSync(SQL_PATH, "utf8"); const code = src.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).toMatch(/create trigger trg_accounts_insert_privileged_columns before insert on accounts\s+for each row/);
    expect(code).toMatch(/security definer set search_path = public/); expect(code).toMatch(/^begin;/m); expect(code).toMatch(/^commit;/m);
    expect(code).not.toMatch(/\b(update|delete|truncate)\b|drop (table|column|policy)/i);
  });
});
