import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as coreModule from "../../scripts/ci-residue/core.mjs";
import * as pinnedModule from "../../scripts/ci-residue/pinned.mjs";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { sha256, stable } = coreModule as any; const { PINNED_PLAN_SHA256, DEFAULT_PLAN } = pinnedModule as any; // eslint-disable-line @typescript-eslint/no-explicit-any

// CLI 를 실제로 실행하되, 모든 경우가 네트워크 접속 "전에" 중단되는 입력만 쓴다(공유 DEV 접속 없음).
const run = (script: string, args: string[], env: Record<string, string>) => spawnSync("node", ["--no-warnings", `scripts/ci-residue/${script}`, ...args], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" as const, timeout: 20000 });
const envFile = (url: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ci-cli-")); const f = path.join(d, "env"); fs.writeFileSync(f, `NEXT_PUBLIC_SUPABASE_URL=${url}\nSUPABASE_SERVICE_ROLE_KEY=not-a-real-key\n`); return f; };

describe("ci-residue CLI(오프라인 안전장치)", () => {
  it("커밋된 계획의 해시가 고정값과 같고, 승인 후보 형식(소유 증명 아님)이다", () => {
    const plan = JSON.parse(fs.readFileSync(DEFAULT_PLAN, "utf8"));
    expect(sha256(stable(plan))).toBe(PINNED_PLAN_SHA256);
    expect(plan.approvalCandidate).toBe(true); expect(plan.ownershipProven).toBe(false); expect(plan.classes).toHaveLength(23);
    expect(plan.allowedProfiles.every((p: { profileId: string; accountId: string }) => /^[0-9a-f-]{36}$/.test(p.profileId) && /^[0-9a-f-]{36}$/.test(p.accountId))).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);   // 이메일 등 개인정보가 계획에 없다
  });
  for (const [name, url] of [["로컬/HTTP", "http://127.0.0.1:3203"], ["호스트 접미 위장", "https://jdglfvwdnkjnraqdxuuj.supabase.co.evil.com"], ["경로 위장", "https://evil.com/jdglfvwdnkjnraqdxuuj.supabase.co"], ["Production", "https://bxntqggkfwnhcczsbqtj.supabase.co"], ["포트 포함", "https://jdglfvwdnkjnraqdxuuj.supabase.co:8443"]] as const) {
    it(`purge: 대상이 정확한 공유 DEV 호스트가 아니면(${name}) 접속 전에 중단`, () => {
      const r = run("purge.mjs", [], { PURGE_ENV_FILE: envFile(url) }); expect(r.status).toBe(2); expect(r.stderr).toContain("대상 검증 실패");
    });
    it(`restore: 같은 검증(${name})`, () => {
      const b = path.join(os.tmpdir(), "nonexistent-backup.json"); fs.writeFileSync(b, "{}");
      const r = run("restore.mjs", [b], { PURGE_ENV_FILE: envFile(url) }); expect(r.status).toBe(2); expect(r.stderr).toContain("대상 검증 실패");
    });
  }
  it("계획이 한 글자라도 바뀌면(해시 불일치) purge 가 중단", () => {
    const plan = JSON.parse(fs.readFileSync(DEFAULT_PLAN, "utf8")); plan.classes[0].title += "x";
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ci-plan-")), "plan.json"); fs.writeFileSync(f, JSON.stringify(plan));
    const r = run("purge.mjs", ["--plan", f], { PURGE_ENV_FILE: envFile("https://jdglfvwdnkjnraqdxuuj.supabase.co") }); expect(r.status).toBe(2); expect(r.stderr).toContain("계획 해시");
  });
  it("--execute 는 ACK 없이는 접속 전에 중단(정확한 호스트여도)", () => {
    // 올바른 호스트라도 ACK/backup-dir 없이는 runPurge 가 읽기 전에 거부한다 — 이 경로는 네트워크 접속 전에 예외를 던진다.
    const r = run("purge.mjs", ["--execute"], { PURGE_ENV_FILE: envFile("https://jdglfvwdnkjnraqdxuuj.supabase.co") }); expect(r.status).toBe(4); expect(r.stderr).toMatch(/PURGE_ACK/);
  });
});
