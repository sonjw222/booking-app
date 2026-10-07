// @ts-nocheck
import { describe, expect, it } from "vitest";
import { checkSchemaDump, stripDollarQuoted } from "../../scripts/ci-dev/schemaDumpCheck.mjs";

const jwt = "eyJhbGciOiJIUzI1NiJ9" + ".eyJyb2xlIjoic2VydmljZV9yb2xlIn0" + ".abcdefghij";
describe("schemaDumpCheck", () => {
  it("순수 스키마(DDL, 함수 본문 안의 INSERT 포함)는 통과", () => {
    const sql = `CREATE TABLE public.centers (id uuid primary key, name text);\nALTER TABLE public.centers ENABLE ROW LEVEL SECURITY;\nCREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  INSERT INTO public.logs(x) VALUES (1);\nEND;\n$$;\n-- comment support@mwhabit.com`;
    expect(checkSchemaDump(sql)).toEqual({ ok: true, findings: [] });
  });
  it("COPY ... FROM stdin / 최상위 INSERT INTO는 실패", () => {
    expect(checkSchemaDump("COPY public.accounts (id) FROM stdin;\n1\n\\.\n").findings[0].kind).toMatch(/COPY/);
    expect(checkSchemaDump("INSERT INTO public.centers VALUES (1);").findings[0].kind).toMatch(/INSERT/);
    expect(checkSchemaDump("  insert into public.centers values (1);").ok).toBe(false);
  });
  it("비밀 형태(JWT, sb_secret, PG 키, private key)는 실패하고 값은 보고에 없다", () => {
    for (const s of [`x := '${jwt}';`, "k = sb_secret_abcdefgh12345", "a test_sk_abcdefgh12345", "-----BEGIN PRIVATE KEY-----", "api_key = 'abcdefghijklmnopqrstuv'"]) expect(checkSchemaDump(s).ok, s).toBe(false);
    expect(JSON.stringify(checkSchemaDump(`x := '${jwt}';`))).not.toContain(jwt);
  });
  it("PII: 실제 이메일/휴대폰은 실패, example.com/noreply는 허용", () => {
    expect(checkSchemaDump("-- 'real.person@naver.com'\nselect 'real.person@naver.com';").ok).toBe(false);
    expect(checkSchemaDump("select '01012345678';").ok).toBe(false);
    expect(checkSchemaDump("select 'a@example.com', 'noreply@x.io';").ok).toBe(true);
  });
  it("stripDollarQuoted는 줄 수를 보존한다", () => {
    const s = "a\n$f$\nINSERT INTO x\n$f$\nb"; expect(stripDollarQuoted(s).split("\n").length).toBe(5);
  });
});
