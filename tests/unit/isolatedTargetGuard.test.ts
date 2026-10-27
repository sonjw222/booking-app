import { checkIsolatedTarget, refOfUrl, strictProjectRef } from "../../scripts/ci/isolatedTargetGuard.mjs";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROD = "bxntqggkfwnhcczsbqtj", SHARED = "jdglfvwdnkjnraqdxuuj", ISO = "abcdefghij0123456789";
const jwt = (ref: string) => `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ ref })).toString("base64url")}.sig`;
const good = () => ({ ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co`, ISOLATED_SUPABASE_PROJECT_REF: ISO, ISOLATED_SUPABASE_ANON_KEY: jwt(ISO), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(ISO), NEXT_PUBLIC_SUPABASE_URL: `https://${SHARED}.supabase.co` });

describe("격리 대상 가드(#240)", () => {
  it("정상 격리 프로젝트는 OK", () => expect(checkIsolatedTarget(good()).status).toBe("OK"));
  it("설정이 없으면 BLOCKED(쓰기 전에 중단, 값 출력 없음)", () => {
    const r = checkIsolatedTarget({}); expect(r.status).toBe("BLOCKED"); expect(r.problems.join()).toContain("ISOLATED_SUPABASE_URL");
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: "" }).status).toBe("BLOCKED");
  });
  it("Production 은 격리로 선언할 수 없다(URL·선언 ref·키 어느 쪽이든)", () => {
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_URL: `https://${PROD}.supabase.co`, ISOLATED_SUPABASE_PROJECT_REF: PROD, ISOLATED_SUPABASE_ANON_KEY: jwt(PROD), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(PROD) }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(PROD) }).status).toBe("FAILED");
  });
  it("공유 DEV 는 격리로 선언할 수 없다(고정 ref·CI 의 NEXT_PUBLIC_SUPABASE_URL 둘 다)", () => {
    const shared = { ISOLATED_SUPABASE_URL: `https://${SHARED}.supabase.co`, ISOLATED_SUPABASE_PROJECT_REF: SHARED, ISOLATED_SUPABASE_ANON_KEY: jwt(SHARED), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(SHARED) };
    expect(checkIsolatedTarget(shared).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ...shared, NEXT_PUBLIC_SUPABASE_URL: `https://${SHARED}.supabase.co` }).problems.join()).toContain("공유 DEV");
    // 고정 ref 목록을 몰라도(다른 DEV 로 바뀌어도) CI 가 쓰는 공유 DEV URL 과 같으면 차단
    const other = "zzzzzzzzzz0123456789";
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_URL: `https://${other}.supabase.co`, ISOLATED_SUPABASE_PROJECT_REF: other, ISOLATED_SUPABASE_ANON_KEY: jwt(other), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(other), NEXT_PUBLIC_SUPABASE_URL: `https://${other}.supabase.co` }).status).toBe("FAILED");
  });
  it("URL·선언 ref·키 ref 불일치는 FAILED", () => {
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_PROJECT_REF: "bbbbbbbbbb0123456789" }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_ANON_KEY: jwt("bbbbbbbbbb0123456789") }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_ANON_KEY: "not-a-jwt" }).status).toBe("FAILED");
  });
  it("프록시/임의 호스트는 격리 프로젝트로 인정하지 않는다", () => {
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_URL: "https://db.example.test" }).status).toBe("FAILED");
  });
  it("로컬 대체는 PARTIAL — 전체 통합 검증으로 보고하면 안 된다", () => {
    const r = checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_URL: "http://127.0.0.1:3203" });
    expect(r.status).toBe("PARTIAL"); expect(r.problems.join()).toContain("Auth/Storage/Realtime");
  });
  it("refOfUrl", () => { expect(refOfUrl(`https://${ISO}.supabase.co/`)).toBe(ISO); expect(refOfUrl("http://127.0.0.1:3203")).toBeNull(); });
});

describe("격리 대상 가드 — 엄격한 URL 검증(입력된 값 하나만 있어도 평가)", () => {
  const ok = `https://${ISO}.supabase.co`;
  const BAD_URLS: Array<[string, string]> = [
    ["HTTP", `http://${ISO}.supabase.co`], ["사용자정보", `https://user:pw@${ISO}.supabase.co`], ["사용자정보(@ 위장)", `https://${ISO}.supabase.co@evil.com`],
    ["별도 포트", `https://${ISO}.supabase.co:8443`], ["루트 외 경로", `https://${ISO}.supabase.co/rest/v1`], ["경로 위장", `https://evil.com/${ISO}.supabase.co`],
    ["쿼리", `https://${ISO}.supabase.co/?a=1`], ["쿼리(슬래시 없음)", `https://${ISO}.supabase.co?a=1`], ["fragment", `https://${ISO}.supabase.co/#x`],
    ["호스트 접미 위장", `https://${ISO}.supabase.co.evil.com`], ["19자 ref", "https://abcdefghij012345678.supabase.co"], ["공백 포함", ` https://${ISO}.supabase.co /`],
    ["스킴 없음", `${ISO}.supabase.co`], ["임의 호스트", "https://db.example.test"], ["빈 경로 점", `https://${ISO}.supabase.co/.`],
  ];
  it("정상 기본 주소(끝 슬래시 유무, 대소문자)만 통과", () => {
    for (const u of [ok, `${ok}/`, `HTTPS://${ISO.toUpperCase()}.SUPABASE.CO/`]) expect(strictProjectRef(u).ref, u).toBe(ISO);
    for (const [name, u] of BAD_URLS) expect(strictProjectRef(u).error, name).toBeTruthy();
  });
  for (const [name, u] of BAD_URLS) {
    it(`URL 하나만 입력돼도(${name}) FAILED — 다른 필수값 누락은 이유가 되지 못한다`, () => {
      const r = checkIsolatedTarget({ ISOLATED_SUPABASE_URL: u }); expect(r.status).toBe("FAILED");
    });
  }
  it("로컬 대체 URL 은 엄격 규칙 대상이 아니고 PARTIAL 로 유지(HTTP·포트 허용)", () => {
    for (const u of ["http://127.0.0.1:3203", "http://localhost:54321", "http://[::1]:3203"]) expect(checkIsolatedTarget({ ISOLATED_SUPABASE_URL: u }).status, u).toBe("PARTIAL");
  });
});

describe("격리 대상 가드 — 위험한 설정 검사를 누락 검사보다 먼저", () => {
  it("운영·공유 DEV 대상이 하나만 입력돼도 FAILED(다른 값 없음)", () => {
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_URL: `https://${PROD}.supabase.co` }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_URL: `https://${SHARED}.supabase.co` }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_PROJECT_REF: PROD }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_PROJECT_REF: SHARED }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(PROD) }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_ANON_KEY: jwt(SHARED) }).status).toBe("FAILED");
  });
  it("잘못된 형식 하나(JWT 아님·ref 형식 오류)만 입력돼도 FAILED", () => {
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_ANON_KEY: "not-a-jwt" }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_PROJECT_REF: "short" }).status).toBe("FAILED");
  });
  it("프로젝트 불일치는 두 값만 있어도 FAILED", () => {
    const other = "bbbbbbbbbb0123456789";
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co`, ISOLATED_SUPABASE_PROJECT_REF: other }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_PROJECT_REF: ISO, ISOLATED_SUPABASE_ANON_KEY: jwt(other) }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_ANON_KEY: jwt(ISO), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(other) }).status).toBe("FAILED");
  });
  it("위험이 있으면 로컬 URL 이어도 FAILED(PARTIAL 보다 우선)", () => {
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_URL: "http://127.0.0.1:3203", ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(PROD) }).status).toBe("FAILED");
  });
  it("전부 없거나 안전한 값만 일부 있으면 BLOCKED(FAILED 와 구분)", () => {
    expect(checkIsolatedTarget({}).status).toBe("BLOCKED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co` }).status).toBe("BLOCKED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_PROJECT_REF: ISO, ISOLATED_SUPABASE_ANON_KEY: jwt(ISO) }).status).toBe("BLOCKED");
    expect(checkIsolatedTarget({ ISOLATED_SUPABASE_URL: "  ", ISOLATED_SUPABASE_PROJECT_REF: "" }).status).toBe("BLOCKED");
  });
});

describe("격리 대상 가드 — 실제 CLI 종료 코드(자격증명·네트워크 없음)", () => {
  // 환경을 PATH 와 ISOLATED_* 만으로 비운 자식 프로세스에서 실제 CLI 를 실행한다. 이 스크립트에는 Supabase 접속 코드가 없다.
  const cli = (env: Record<string, string>, summary?: string) => spawnSync("node", ["--no-warnings", "scripts/ci/isolatedTargetGuard.mjs"], {
    env: { PATH: process.env.PATH ?? "", ...(summary ? { GITHUB_STEP_SUMMARY: summary } : {}), ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" as const, timeout: 15000,
  });
  const tmpSummary = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-")), "summary.md");
  const ALLOW = { ISOLATED_GATE_ALLOW_BLOCKED: "1" };
  it("설정 전부 없음: BLOCKED → 기본 1, ALLOW_BLOCKED=1 이면 0(warning 출력)", () => {
    expect(cli({}).status).toBe(1);
    const r = cli({ ...ALLOW }); expect(r.status).toBe(0); expect(r.stdout).toContain("BLOCKED"); expect(r.stdout).toContain("::warning::");
  });
  it("안전한 값만 일부 있음: BLOCKED(ALLOW 이면 0)", () => {
    const r = cli({ ...ALLOW, ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co` }); expect(r.status).toBe(0); expect(r.stdout).toContain("BLOCKED");
  });
  const DANGEROUS: Array<[string, Record<string, string>]> = [
    ["Production URL 하나", { ISOLATED_SUPABASE_URL: `https://${PROD}.supabase.co` }], ["공유 DEV URL 하나", { ISOLATED_SUPABASE_URL: `https://${SHARED}.supabase.co` }],
    ["공유 DEV ref 하나", { ISOLATED_SUPABASE_PROJECT_REF: SHARED }], ["Production 키 하나", { ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(PROD) }],
    ["HTTP URL", { ISOLATED_SUPABASE_URL: `http://${ISO}.supabase.co` }], ["사용자정보 URL", { ISOLATED_SUPABASE_URL: `https://u:p@${ISO}.supabase.co` }], ["포트 URL", { ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co:8443` }],
    ["경로 URL", { ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co/x` }], ["쿼리 URL", { ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co/?a=1` }], ["fragment URL", { ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co/#a` }],
    ["URL/키 프로젝트 불일치", { ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co`, ISOLATED_SUPABASE_ANON_KEY: jwt("bbbbbbbbbb0123456789") }], ["JWT 아닌 키", { ISOLATED_SUPABASE_ANON_KEY: "x" }],
  ];
  for (const [name, env] of DANGEROUS) {
    it(`FAILED(${name}): ALLOW_BLOCKED=1 이어도 반드시 실패 종료(1)`, () => {
      const r = cli({ ...ALLOW, ...env }); expect(r.status).toBe(1); expect(r.stdout).toContain("FAILED"); expect(r.stdout).not.toContain("::warning::");
      expect(r.stdout + r.stderr).not.toContain(jwt(PROD));                      // 키 값을 출력하지 않는다
    });
  }
  it("로컬 대체 URL: PARTIAL → ALLOW_BLOCKED=1 이어도 종료 3(전체 게이트 미통과)", () => {
    const r = cli({ ...ALLOW, ISOLATED_SUPABASE_URL: "http://127.0.0.1:3203" }); expect(r.status).toBe(3); expect(r.stdout).toContain("PARTIAL");
  });
  it("모두 안전하게 갖춰지면 OK(0), Step Summary 에는 FAILED/BLOCKED 사유가 기록된다", () => {
    const okEnv = { ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co`, ISOLATED_SUPABASE_PROJECT_REF: ISO, ISOLATED_SUPABASE_ANON_KEY: jwt(ISO), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(ISO) };
    expect(cli(okEnv).status).toBe(0);
    const f = tmpSummary(); expect(cli({ ...ALLOW, ISOLATED_SUPABASE_URL: `https://${PROD}.supabase.co` }, f).status).toBe(1);
    expect(fs.readFileSync(f, "utf8")).toContain("FAILED");
    const f2 = tmpSummary(); expect(cli({ ...ALLOW }, f2).status).toBe(0); expect(fs.readFileSync(f2, "utf8")).toContain("BLOCKED");
    // Step Summary 안내: 가드 미통과면 fixture 생성과 live 테스트를 시작하지 않는다 — 예전 문구("계속 공유 DEV 에서 실행")가 남아 있으면 안 된다.
    for (const summary of [fs.readFileSync(f, "utf8"), fs.readFileSync(f2, "utf8")]) {
      expect(summary).toContain("fixture 생성과 live 테스트를 시작하지 않습니다");
      expect(summary).toContain("공유 DEV·운영·다른 환경으로 대체하지 않습니다");
      expect(summary).not.toMatch(/계속 공유 DEV|공유 DEV 에서 실행/);
    }
  });
});

describe("격리 대상 가드 — ephemeral-local-stack(일회용 로컬 Supabase 전체 스택)", () => {
  const demo = (role: string, extra: object = {}) => `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: "supabase-demo", role, exp: 1983812996, ...extra })).toString("base64url")}.sig`;
  const good = () => ({ ISOLATED_KIND: "ephemeral-local-stack", ISOLATED_SUPABASE_URL: "http://127.0.0.1:54421", ISOLATED_SUPABASE_PROJECT_REF: "local:mwhabit-isolated", ISOLATED_SUPABASE_ANON_KEY: demo("anon"), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: demo("service_role") });
  it("정확한 로컬 URL·스택 id·데모 키가 모두 맞을 때만 OK(kind 표시)", () => {
    const r = checkIsolatedTarget(good()); expect(r.status).toBe("OK"); expect(r.kind).toBe("ephemeral-local-stack");
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_URL: "http://localhost:54421/" }).status).toBe("OK");
  });
  it("kind 없이는 같은 값이어도 로컬 URL 은 PARTIAL 로 남는다(전체 통합으로 보고 금지)", () => {
    const { ISOLATED_KIND, ...rest } = good(); void ISOLATED_KIND;
    expect(checkIsolatedTarget({ ...rest, ISOLATED_SUPABASE_PROJECT_REF: "abcdefghij0123456789", ISOLATED_SUPABASE_ANON_KEY: jwt("abcdefghij0123456789"), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt("abcdefghij0123456789") }).status).toBe("PARTIAL");
  });
  const BAD: Array<[string, Record<string, string>]> = [
    ["호스팅 프로젝트 URL", { ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co` }], ["https 로컬", { ISOLATED_SUPABASE_URL: "https://127.0.0.1:54421" }], ["경로 포함", { ISOLATED_SUPABASE_URL: "http://127.0.0.1:54421/rest/v1" }],
    ["사용자정보 로컬", { ISOLATED_SUPABASE_URL: "http://u:p@127.0.0.1:54421" }], ["원격 호스트", { ISOLATED_SUPABASE_URL: "http://10.0.0.5:54421" }],
    ["다른 스택 id", { ISOLATED_SUPABASE_PROJECT_REF: "local:other" }], ["호스팅 ref 선언", { ISOLATED_SUPABASE_PROJECT_REF: ISO }],
    ["호스팅 프로젝트 키(ref 클레임)", { ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(ISO) }], ["Production 키", { ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(PROD) }], ["공유 DEV 키", { ISOLATED_SUPABASE_ANON_KEY: jwt(SHARED) }],
    ["데모가 아닌 iss", { ISOLATED_SUPABASE_ANON_KEY: demo("anon", { iss: "https://x.supabase.co/auth/v1" }) }], ["role 불일치(anon 자리에 service_role)", { ISOLATED_SUPABASE_ANON_KEY: demo("service_role") }],
    ["JWT 아님", { ISOLATED_SUPABASE_SERVICE_ROLE_KEY: "nope" }], ["알 수 없는 kind", { ISOLATED_KIND: "something-else" }],
  ];
  for (const [name, over] of BAD) it(`FAILED(${name})`, () => expect(checkIsolatedTarget({ ...good(), ...over }).status).toBe("FAILED"));
  it("kind 만 있고 값이 없으면 BLOCKED, 위험한 값 하나만 있어도 FAILED", () => {
    expect(checkIsolatedTarget({ ISOLATED_KIND: "ephemeral-local-stack" }).status).toBe("BLOCKED");
    expect(checkIsolatedTarget({ ISOLATED_KIND: "ephemeral-local-stack", ISOLATED_SUPABASE_URL: `https://${PROD}.supabase.co` }).status).toBe("FAILED");
  });
  const cli = (env: Record<string, string>) => spawnSync("node", ["--no-warnings", "scripts/ci/isolatedTargetGuard.mjs"], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" as const, timeout: 15000 });
  it("실제 CLI: OK 는 종료 0 + kind 출력, 호스팅 키는 ALLOW_BLOCKED=1 이어도 1, 키 값은 출력되지 않는다", () => {
    const ok = cli(good()); expect(ok.status).toBe(0); expect(ok.stdout).toContain("kind=ephemeral-local-stack"); expect(ok.stdout).toContain("호스팅 프로젝트가 아니다"); expect(ok.stdout + ok.stderr).not.toContain(demo("anon"));
    const bad = cli({ ...good(), ISOLATED_GATE_ALLOW_BLOCKED: "1", ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(ISO) }); expect(bad.status).toBe(1); expect(bad.stdout).toContain("FAILED");
  });
});
