#!/usr/bin/env node
/*
  격리 테스트 환경 가드(#240, 2026-10-26) — 네트워크/DB 접근 없이 환경변수만 검사한다. 어떤 쓰기보다 먼저 실행하는 용도.
  판정: OK(전체 격리 통합 환경으로 선언 가능) / PARTIAL(로컬 대체 — Auth·Storage·Realtime·Edge 없음, 전체 통합 검증으로 보고 금지) /
        BLOCKED(설정 없음 — 실행하지 않음) / FAILED(설정이 위험함 — 실행하지 않음). OK 가 아니면 live 쓰기를 시작하지 않는다.
  규칙: Production ref/도메인 차단 · 공유 DEV(mwhabit-ci-dev)는 격리로 선언 불가 · URL ref = 선언 ref = 키의 JWT ref 불일치 차단 · 필수 값 누락은 BLOCKED.
  비밀 값은 출력하지 않는다(변수 이름과 project ref 만).
*/
import { pathToFileURL } from "node:url";
import { KNOWN_PRODUCTION_PROJECT_REFS, projectRefFromSupabaseKey } from "./liveEnvPreflight.mjs";

export const KNOWN_SHARED_DEV_PROJECT_REFS = ["jdglfvwdnkjnraqdxuuj"]; // docs/CI_DEV_SUPABASE_SETUP.md 의 mwhabit-ci-dev
const REF_IN_HOST = /^([a-z0-9]{20})\.supabase\.(co|in)$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function parseUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
}
export function refOfUrl(raw) {
  const u = parseUrl(raw); if (!u) return null;
  const m = u.hostname.toLowerCase().replace(/\.+$/, "").match(REF_IN_HOST);
  return m ? m[1] : null;
}

/** env: ISOLATED_SUPABASE_URL / _PROJECT_REF / _ANON_KEY / _SERVICE_ROLE_KEY, 비교용 SHARED_DEV_SUPABASE_URL(= CI secret NEXT_PUBLIC_SUPABASE_URL), PRODUCTION_SUPABASE_URL */
export function checkIsolatedTarget(env) {
  const problems = [];
  const url = String(env.ISOLATED_SUPABASE_URL ?? "").trim();
  const declared = String(env.ISOLATED_SUPABASE_PROJECT_REF ?? "").trim().toLowerCase();
  const missing = ["ISOLATED_SUPABASE_URL", "ISOLATED_SUPABASE_PROJECT_REF", "ISOLATED_SUPABASE_ANON_KEY", "ISOLATED_SUPABASE_SERVICE_ROLE_KEY"].filter((n) => !String(env[n] ?? "").trim());
  const parsed = parseUrl(url);

  // 로컬 대체(PostgreSQL+PostgREST): 전체 Supabase 통합이 아니다.
  if (parsed && LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    return { status: "PARTIAL", problems: ["로컬 대체 환경 — Supabase Auth/Storage/Realtime/Edge Functions 가 없어 live E2E·Integration(로그인·스토리지·함수 호출)을 대체하지 못함. 전체 Supabase 통합 검증으로 보고하지 말 것"] };
  }
  if (missing.length) return { status: "BLOCKED", problems: [`격리 환경 설정 없음: ${missing.join(", ")} (네트워크 호출·쓰기를 시작하지 않음)`] };
  if (!parsed) problems.push("ISOLATED_SUPABASE_URL 을 URL 로 해석할 수 없음");
  const urlRef = refOfUrl(url);
  if (parsed && !urlRef) problems.push("ISOLATED_SUPABASE_URL 이 <project-ref>.supabase.co 형태가 아님(프록시/임의 호스트는 격리 대상으로 인정하지 않음)");
  if (urlRef && urlRef !== declared) problems.push(`URL 의 project ref(${urlRef}) 와 선언된 ISOLATED_SUPABASE_PROJECT_REF(${declared}) 가 다름`);
  for (const name of ["ISOLATED_SUPABASE_ANON_KEY", "ISOLATED_SUPABASE_SERVICE_ROLE_KEY"]) {
    const kref = projectRefFromSupabaseKey(env[name]);
    if (!kref) problems.push(`${name} 에서 project ref 를 확인할 수 없음(JWT 형식 아님)`);
    else if (kref !== declared) problems.push(`${name} 의 project ref(${kref}) 가 선언된 격리 ref(${declared}) 와 다름`);
  }
  const forbidden = new Map([...KNOWN_PRODUCTION_PROJECT_REFS.map((r) => [r, "Production"]), ...KNOWN_SHARED_DEV_PROJECT_REFS.map((r) => [r, "공유 DEV(mwhabit-ci-dev)"])]);
  const sharedFromEnv = refOfUrl(env.SHARED_DEV_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL);
  if (sharedFromEnv) forbidden.set(sharedFromEnv, "공유 DEV(CI 의 NEXT_PUBLIC_SUPABASE_URL)");
  const prodFromEnv = refOfUrl(env.PRODUCTION_SUPABASE_URL); if (prodFromEnv) forbidden.set(prodFromEnv, "Production(PRODUCTION_SUPABASE_URL)");
  for (const ref of [urlRef, declared, projectRefFromSupabaseKey(env.ISOLATED_SUPABASE_ANON_KEY), projectRefFromSupabaseKey(env.ISOLATED_SUPABASE_SERVICE_ROLE_KEY)]) {
    if (ref && forbidden.has(ref)) problems.push(`격리 환경으로 선언된 project ref(${ref})가 ${forbidden.get(ref)} 임 — 격리 환경이 될 수 없음`);
  }
  if (/supabase\.(co|in)/i.test(url) && /(^|[./])bxntqgg/i.test(url)) problems.push("URL 에 Production 도메인 조각이 있음");
  return { status: problems.length ? "FAILED" : "OK", problems: [...new Set(problems)] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { status, problems } = checkIsolatedTarget(process.env);
  const line = `isolated-target-guard: ${status}`;
  if (status === "OK") { console.log(`${line} — 격리 대상 확인됨(값은 출력하지 않음).`); process.exit(0); }
  console.log(line); for (const p of problems) console.log(`  - ${p}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { (await import("node:fs")).appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 격리 환경 게이트(#240): **${status}**\n${problems.map((p) => `- ${p}`).join("\n")}\n\n이 상태에서는 격리 전환이 완료된 것이 아니며, live E2E/Integration 은 계속 공유 DEV 에서 실행됩니다.\n`); } catch { /* 요약 기록 실패는 판정에 영향 없음 */ }
  }
  if (status === "BLOCKED" && process.env.ISOLATED_GATE_ALLOW_BLOCKED === "1") { console.log("::warning::격리 환경 미구성(BLOCKED) — 전환 미완료"); process.exit(0); }
  process.exit(status === "PARTIAL" ? 3 : 1);
}
