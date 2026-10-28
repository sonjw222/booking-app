import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadIsolatedEnv } from "../../scripts/isolated/nicepayReview/assertIsolated.mjs";

const root = path.resolve(__dirname, "../..");
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(p)}.sig`;
const demoAnon = jwt({ iss: "supabase-demo", role: "anon", exp: 1983812996 }), demoSvc = jwt({ iss: "supabase-demo", role: "service_role", exp: 1983812996 });
const hostedAnon = jwt({ iss: "supabase", ref: "abcdefghij0123456789", role: "anon" }), hostedSvc = jwt({ iss: "supabase", ref: "abcdefghij0123456789", role: "service_role" });
const envText = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
const base = { TEST_USER_A_EMAIL: "a@x.test", TEST_USER_A_PASSWORD: "x", TEST_USER_B_EMAIL: "b@x.test", TEST_USER_B_PASSWORD: "x", TEST_MANAGER_A_EMAIL: "m@x.test", TEST_MANAGER_A_PASSWORD: "x", TEST_MANAGER_B_EMAIL: "n@x.test", TEST_MANAGER_B_PASSWORD: "x" };
const bad: Record<string, Record<string, string>> = {
  "호스팅 프로젝트 주소(20자 ref)": { ...base, NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij0123456789.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: hostedAnon, SUPABASE_SERVICE_ROLE_KEY: hostedSvc },
  "운영 프로젝트 주소": { ...base, NEXT_PUBLIC_SUPABASE_URL: "https://bxntqggkfwnhcczsbqtj.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: hostedAnon, SUPABASE_SERVICE_ROLE_KEY: hostedSvc },
  "공유 DEV 프로젝트 주소": { ...base, NEXT_PUBLIC_SUPABASE_URL: "https://jdglfvwdnkjnraqdxuuj.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: hostedAnon, SUPABASE_SERVICE_ROLE_KEY: hostedSvc },
  "로컬 주소 + 호스팅 키": { ...base, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54421", NEXT_PUBLIC_SUPABASE_ANON_KEY: hostedAnon, SUPABASE_SERVICE_ROLE_KEY: hostedSvc },
  "로컬 주소 + 잘못된 키": { ...base, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54421", NEXT_PUBLIC_SUPABASE_ANON_KEY: "garbage", SUPABASE_SERVICE_ROLE_KEY: "garbage" },
  "임의 외부 주소": { ...base, NEXT_PUBLIC_SUPABASE_URL: "http://example.com:54421", NEXT_PUBLIC_SUPABASE_ANON_KEY: demoAnon, SUPABASE_SERVICE_ROLE_KEY: demoSvc },
  "주소 없음": { ...base, NEXT_PUBLIC_SUPABASE_ANON_KEY: demoAnon, SUPABASE_SERVICE_ROLE_KEY: demoSvc },
};
const scripts = ["permissionMatrix.mjs", "reservationGuard.mjs", "flagTamper.mjs", "rollbackScenarios.mjs", "mismatchedCenterRepro.mjs", "browserHistoryCategory.mjs", "browserPersonas.mjs", "gateMatrix.mjs", "setupExtraPersonas.mjs", "accountsFlagGuard.mjs", "idMismatch.mjs", "gateReviewerTarget.mjs"];

describe("nicepayReview 검증 스크립트 — 일회용 로컬 스택이 아니면 네트워크 요청 0건으로 중단", () => {
  it("올바른 로컬 데모 환경은 통과, 나쁜 환경은 모두 throw(값 미출력)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "iso-guard-")); try {
      const ok = path.join(dir, "ok.env"); writeFileSync(ok, envText({ ...base, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54421", NEXT_PUBLIC_SUPABASE_ANON_KEY: demoAnon, SUPABASE_SERVICE_ROLE_KEY: demoSvc }));
      expect(() => loadIsolatedEnv(ok)).not.toThrow();
      for (const [name, e] of Object.entries(bad)) { const f = path.join(dir, "bad.env"); writeFileSync(f, envText(e)); expect(() => loadIsolatedEnv(f), name).toThrow(/ISOLATED_GUARD/); }
      expect(() => loadIsolatedEnv(undefined as unknown as string)).toThrow(/ISOLATED_GUARD/); expect(() => loadIsolatedEnv(path.join(dir, "none.env"))).toThrow(/ISOLATED_GUARD/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  for (const script of scripts) it(`${script}: 잘못된 환경 파일 ${Object.keys(bad).length}종 + 파일 없음 → 종료 코드 ≠ 0, 네트워크 시도 0건`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "iso-guard-")); try {
      const cases: Array<[string, string | undefined]> = [...Object.entries(bad).map(([n, e]): [string, string] => { const f = path.join(dir, n.replace(/\W/g, "_") + ".env"); writeFileSync(f, envText(e)); return [n, f]; }), ["환경 파일 미지정", undefined]];
      for (const [name, file] of cases) {
        const countFile = path.join(dir, "count.txt"); rmSync(countFile, { force: true });
        const r = spawnSync(process.execPath, ["--import", path.join(root, "scripts/isolated/nicepayReview/countNetwork.preload.mjs"), path.join(root, "scripts/isolated/nicepayReview", script)], { cwd: root, encoding: "utf8", env: { ...process.env, NET_COUNT_FILE: countFile, ...(file ? { ISO_ENV_FILE: file } : { ISO_ENV_FILE: "" }) } });
        expect(r.status, `${script} / ${name}`).not.toBe(0);
        expect(r.stderr, `${script} / ${name}`).toMatch(/ISOLATED_GUARD/);
        expect(Number(readFileSync(countFile, "utf8")), `${script} / ${name} 네트워크 시도`).toBe(0);
        expect(r.stderr + r.stdout).not.toContain(hostedSvc); expect(r.stderr + r.stdout).not.toMatch(/abcdefghij0123456789|bxntqggk|jdglfvwd/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
