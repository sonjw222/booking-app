/*
  격리 스택 migration 이 운영에 적용된 보안 SQL(루트 fix_accounts_insert_privileged_columns_20261030.sql)과 같은 보호를 설치하는지 고정한다.
  새 일회용 Supabase(CI·로컬)가 이 보호 없이 뜨면(= baseline 만 있으면) 가입 INSERT 우회 회귀를 아무 시험도 잡지 못하므로, 두 파일이 어긋나거나 migration 이 사라지면 이 시험이 실패한다.
*/
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const MIG_DIR = path.join(root, "isolated-supabase/supabase/migrations");
const ROOT_SQL = path.join(root, "fix_accounts_insert_privileged_columns_20261030.sql");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--") && l.trim() !== "").map((l) => l.trim()).filter((l) => !/^(begin|commit);$/i.test(l)).join("\n");

describe("격리 스택 migration ↔ 운영 적용 SQL 동일성", () => {
  const files = readdirSync(MIG_DIR).filter((f) => /accounts_insert_privileged_columns/.test(f));
  it("migration 이 존재하고 baseline(20261027…) 뒤에 실행되는 이름이다", () => {
    expect(files).toHaveLength(1);
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(files[0])).toBeGreaterThan(all.findIndex((f) => /baseline_public_schema/.test(f)));
  });
  it("실행 코드(주석·begin/commit 제외)가 루트 보안 SQL 과 글자 그대로 같다", () => {
    const mig = readFileSync(path.join(MIG_DIR, files[0]), "utf8");
    expect(code(mig)).toBe(code(readFileSync(ROOT_SQL, "utf8")));
    expect(code(mig)).toMatch(/create trigger trg_accounts_insert_privileged_columns before insert on accounts/);
  });
  it("migration 은 자체 트랜잭션 문을 갖지 않는다(CLI 가 감싼다)·멱등(create or replace / drop trigger if exists)", () => {
    const mig = readFileSync(path.join(MIG_DIR, files[0]), "utf8"); const c = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(c).not.toMatch(/^\s*(begin|commit);/im); expect(c).toMatch(/create or replace function enforce_accounts_insert_privileged_columns/); expect(c).toMatch(/drop trigger if exists trg_accounts_insert_privileged_columns/);
  });
});
