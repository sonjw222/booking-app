#!/usr/bin/env node
/*
  live-test env preflight(2026-10-07) — 네트워크/브라우저/DB 접근 없이 환경변수만 검사한다.
  Production Supabase(project ref 고정)를 가리키거나 대상 URL이 없으면 exit 1, 아니면 exit 0.
  tests/integration/productionGuard.ts와 같은 판정 규칙의 독립 복제본이다(workflow job이 npm ci 없이 돌 수 있게) —
  tests/unit/liveEnvPreflight.parity.test.ts가 두 구현이 같은 입력에 같은 결과를 내는지 확인한다.
  비밀 값(URL 원문, 키)은 출력하지 않는다(변수 "이름"과 project ref만).
*/
import { pathToFileURL } from "node:url";

export const KNOWN_PRODUCTION_PROJECT_REFS = ["bxntqggkfwnhcczsbqtj"];

function hostnameOf(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  for (const candidate of [s, `https://${s}`]) {
    try { const h = new URL(candidate).hostname.toLowerCase().replace(/\.+$/, ""); if (h) return h; } catch { /* next */ }
  }
  return null;
}
export function productionRefInUrl(raw) {
  if (!raw || !String(raw).trim()) return null;
  const haystack = `${hostnameOf(raw) ?? ""} ${raw}`.toLowerCase();
  return KNOWN_PRODUCTION_PROJECT_REFS.find((ref) => haystack.includes(ref)) ?? null;
}
export function projectRefFromSupabaseKey(key) {
  if (!key) return null;
  const parts = String(key).trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload?.ref === "string" ? payload.ref.toLowerCase() : null;
  } catch { return null; }
}

// { ok, problems: string[] } — problems는 사람이 읽는 한 줄(비밀 값 없음)
export function checkLiveEnv(env) {
  const problems = [];
  if (!String(env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim()) problems.push("NEXT_PUBLIC_SUPABASE_URL이 비어 있어 대상 프로젝트를 확인할 수 없음");
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]) {
    if (productionRefInUrl(env[name])) problems.push(`${name}가 Production Supabase(${KNOWN_PRODUCTION_PROJECT_REFS.join(", ")})를 가리킴`);
  }
  for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"]) {
    const ref = projectRefFromSupabaseKey(env[name]);
    if (ref && KNOWN_PRODUCTION_PROJECT_REFS.includes(ref)) problems.push(`${name}의 키가 Production project(${ref})의 키임`);
  }
  const prod = env.PRODUCTION_SUPABASE_URL, target = env.NEXT_PUBLIC_SUPABASE_URL;
  if (prod && target) { const a = hostnameOf(prod), b = hostnameOf(target); if (a && b && a === b) problems.push("NEXT_PUBLIC_SUPABASE_URL이 PRODUCTION_SUPABASE_URL과 같음"); }
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, problems } = checkLiveEnv(process.env);
  if (ok) { console.log("live-env-preflight: OK — 대상은 Production이 아닌 것으로 확인됨(값은 출력하지 않음)."); process.exit(0); }
  console.error("live-env-preflight: FAILED — live 테스트(E2E/Integration)를 시작하지 않습니다.");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("조치: GitHub Repository Secrets를 개발/테스트 전용 Supabase 프로젝트 값으로 교체하세요(docs/CI_DEV_SUPABASE_SETUP.md). Guard를 약화하거나 Production을 허용하지 마세요.");
  process.exit(1);
}
