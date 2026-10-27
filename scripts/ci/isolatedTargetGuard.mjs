#!/usr/bin/env node
/*
  격리 테스트 환경 가드(#240) — 환경변수만 검사한다: 이 스크립트는 Supabase API·DB 를 호출하지 않는다(네트워크 접속 코드가 없음). 어떤 쓰기보다 먼저 실행하는 용도.
  (이 스크립트를 돌리는 CI job 은 GitHub 의 actions/checkout·setup-node 를 실행한다 — "네트워크가 전혀 없다"는 뜻이 아니라 "Supabase 호출이 없다"는 뜻이다.)
  판정: OK(전체 격리 통합 환경으로 선언 가능) / PARTIAL(로컬 대체 — Auth·Storage·Realtime·Edge 없음, 전체 통합 검증으로 보고 금지) /
        BLOCKED(설정이 전부 없거나 안전한 값만 일부 있음 — 실행하지 않음) / FAILED(입력된 값 중 위험하거나 잘못된 것이 있음 — 실행하지 않음). OK 가 아니면 live 쓰기를 시작하지 않는다.
  검사 순서: ① 입력된 값 각각의 위험·오류(Production/공유 DEV 대상, 잘못된 URL, 프로젝트 불일치)를 먼저 본다 — 다른 필수값이 없어도 FAILED.
             ② 위험이 없고 로컬 URL 이면 PARTIAL. ③ 위험이 없고 필수값이 비어 있으면 BLOCKED. ④ 모두 안전하게 갖춰졌으면 OK.
  URL 규칙: 정상적인 HTTPS Supabase 프로젝트 기본 주소 https://<20자 ref>.supabase.co(또는 .in) 만 허용 — HTTP·사용자정보·포트·루트 외 경로·쿼리·fragment·공백 거부.
  종류(ISOLATED_KIND): 기본 hosted-project(별도 호스팅 Supabase 프로젝트) / ephemeral-local-stack(CI 러너 안에서 `supabase start` 로 띄우는 일회용 전체 Supabase 스택: Auth·PostgREST·Storage·Realtime·Edge Functions).
    ephemeral-local-stack 은 URL 이 정확히 http://127.0.0.1|localhost:<포트>, ref 선언이 `local:mwhabit-isolated`, 키가 로컬 데모 JWT(iss=supabase-demo, ref 클레임 없음)일 때만 OK 이다 —
    호스팅 프로젝트의 키는 거부(FAILED). ISOLATED_KIND 없이 로컬 URL 이면 종전대로 PARTIAL(로컬 PostgREST 같은 부분 대체).
  비밀 값은 출력하지 않는다(변수 이름과 project ref 만).
*/
import { pathToFileURL } from "node:url";
import { KNOWN_PRODUCTION_PROJECT_REFS, projectRefFromSupabaseKey } from "./liveEnvPreflight.mjs";

export const KNOWN_SHARED_DEV_PROJECT_REFS = ["jdglfvwdnkjnraqdxuuj"]; // docs/CI_DEV_SUPABASE_SETUP.md 의 mwhabit-ci-dev
const REF_RE = /^[a-z0-9]{20}$/;
const BASE_URL_RE = /^https:\/\/([a-z0-9]{20})\.supabase\.(?:co|in)\/?$/i;   // 사용자정보(@)·포트(:)·경로·쿼리(?)·fragment(#)·공백이 들어갈 자리가 없다
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const isSet = (v) => String(v ?? "").trim() !== "";
export const EPHEMERAL_STACK_ID = "local:mwhabit-isolated";   // isolated-supabase/supabase/config.toml 의 project_id
const EPHEMERAL_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\/?$/;
function jwtClaims(key) {
  const parts = String(key ?? "").trim().split("."); if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { return null; }
}

function parseLoose(raw) {
  const s = String(raw ?? "").trim(); if (!s) return null;
  try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
}
/** 엄격한 기본 주소 검사. 반환: {ref} 또는 {error}. */
export function strictProjectRef(raw) {
  const s = String(raw ?? "").trim();
  const m = BASE_URL_RE.exec(s);
  if (!m) return { error: "정상적인 HTTPS Supabase 프로젝트 기본 주소(https://<project-ref>.supabase.co)가 아님 — HTTP·사용자정보·포트·루트 외 경로·쿼리·fragment 는 거부" };
  return { ref: m[1].toLowerCase() };
}
/** (하위 호환) 느슨한 ref 추출 — 새 로직은 strictProjectRef 를 쓴다. */
export function refOfUrl(raw) {
  const u = parseLoose(raw); if (!u) return null;
  const m = u.hostname.toLowerCase().replace(/\.+$/, "").match(/^([a-z0-9]{20})\.supabase\.(co|in)$/);
  return m ? m[1] : null;
}

/** env: ISOLATED_SUPABASE_URL / _PROJECT_REF / _ANON_KEY / _SERVICE_ROLE_KEY, 비교용 SHARED_DEV_SUPABASE_URL(= CI secret NEXT_PUBLIC_SUPABASE_URL), PRODUCTION_SUPABASE_URL */
export function checkIsolatedTarget(env) {
  const problems = [];
  const url = String(env.ISOLATED_SUPABASE_URL ?? "").trim();
  const declared = String(env.ISOLATED_SUPABASE_PROJECT_REF ?? "").trim().toLowerCase();
  const NAMES = ["ISOLATED_SUPABASE_URL", "ISOLATED_SUPABASE_PROJECT_REF", "ISOLATED_SUPABASE_ANON_KEY", "ISOLATED_SUPABASE_SERVICE_ROLE_KEY"];
  const missing = NAMES.filter((n) => !isSet(env[n]));
  const kind = isSet(env.ISOLATED_KIND) ? String(env.ISOLATED_KIND).trim() : "hosted-project";
  if (!["hosted-project", "ephemeral-local-stack"].includes(kind)) return { status: "FAILED", kind, problems: [`ISOLATED_KIND 값이 알 수 없음(${kind})`] };
  const ephemeral = kind === "ephemeral-local-stack";

  const forbidden = new Map([...KNOWN_PRODUCTION_PROJECT_REFS.map((r) => [r, "Production"]), ...KNOWN_SHARED_DEV_PROJECT_REFS.map((r) => [r, "공유 DEV(mwhabit-ci-dev)"])]);
  const sharedFromEnv = refOfUrl(env.SHARED_DEV_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL); if (sharedFromEnv) forbidden.set(sharedFromEnv, "공유 DEV(CI 의 NEXT_PUBLIC_SUPABASE_URL)");
  const prodFromEnv = refOfUrl(env.PRODUCTION_SUPABASE_URL); if (prodFromEnv) forbidden.set(prodFromEnv, "Production(PRODUCTION_SUPABASE_URL)");

  // ── ① 입력된 값 각각의 위험·오류 (다른 값이 비어 있어도 평가한다) ──
  const refs = []; // [출처, ref]
  let isLocal = false;
  if (isSet(url)) {
    const parsed = parseLoose(url);
    if (ephemeral) { if (!EPHEMERAL_URL_RE.test(url)) problems.push("ephemeral-local-stack 의 ISOLATED_SUPABASE_URL 은 http://127.0.0.1:<포트>(또는 localhost) 형태여야 함"); }
    else if (parsed && LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) isLocal = true;       // 로컬 대체는 PARTIAL(별도 처리) — 엄격 URL 규칙 대상이 아니다
    else {
      const r = strictProjectRef(url);
      if (r.error) problems.push(`ISOLATED_SUPABASE_URL: ${r.error}`); else refs.push(["ISOLATED_SUPABASE_URL", r.ref]);
    }
  }
  if (isSet(declared) && ephemeral) { if (declared !== EPHEMERAL_STACK_ID) problems.push(`ephemeral-local-stack 의 ISOLATED_SUPABASE_PROJECT_REF 는 ${EPHEMERAL_STACK_ID} 여야 함`); }
  else if (isSet(declared)) { if (!REF_RE.test(declared)) problems.push("ISOLATED_SUPABASE_PROJECT_REF 가 20자 소문자·숫자 project ref 형식이 아님"); else refs.push(["ISOLATED_SUPABASE_PROJECT_REF", declared]); }
  for (const name of ["ISOLATED_SUPABASE_ANON_KEY", "ISOLATED_SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!isSet(env[name])) continue;
    const kref = projectRefFromSupabaseKey(env[name]);
    if (ephemeral) {                                            // 로컬 데모 키만: iss=supabase-demo, role 일치, 호스팅 프로젝트 키(ref 클레임)는 거부
      const c = jwtClaims(env[name]); const want = name.includes("ANON") ? "anon" : "service_role";
      if (!c) problems.push(`${name} 이 JWT 형식이 아님`);
      else if (kref || c.ref) problems.push(`${name} 은 호스팅 프로젝트의 키(ref 클레임 있음) — ephemeral-local-stack 에는 쓸 수 없음`);
      else if (c.iss !== "supabase-demo" || c.role !== want) problems.push(`${name} 이 로컬 스택의 데모 키(iss=supabase-demo, role=${want})가 아님`);
      if (kref) refs.push([name, kref]);
      continue;
    }
    if (!kref) problems.push(`${name} 에서 project ref 를 확인할 수 없음(JWT 형식 아님)`); else refs.push([name, kref]);
  }
  for (const [src, ref] of refs) if (forbidden.has(ref)) problems.push(`${src} 의 project ref(${ref})가 ${forbidden.get(ref)} 임 — 격리 환경이 될 수 없음`);
  const distinct = [...new Set(refs.map(([, r]) => r))];
  if (distinct.length > 1) problems.push(`입력된 값들의 project ref 가 서로 다름: ${refs.map(([s, r]) => `${s}=${r}`).join(", ")}`);
  if (problems.length) return { status: "FAILED", kind, problems: [...new Set(problems)] };        // 위험·오류가 있으면 누락 여부와 무관하게 FAILED

  // ── ② 로컬 대체: 별도 PARTIAL ──
  if (isLocal) return { status: "PARTIAL", kind, problems: ["로컬 대체 환경 — Supabase Auth/Storage/Realtime/Edge Functions 가 없어 live E2E·Integration(로그인·스토리지·함수 호출)을 대체하지 못함. 전체 Supabase 통합 검증으로 보고하지 말 것"] };
  // ── ③ 위험은 없는데 비어 있음: BLOCKED ──
  if (missing.length) return { status: "BLOCKED", kind, problems: [`격리 환경 설정이 완전하지 않음(없는 값: ${missing.join(", ")}) — Supabase API·DB 호출과 쓰기를 시작하지 않음`] };
  return { status: "OK", kind, problems: [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { status, kind, problems } = checkIsolatedTarget(process.env);
  const line = `isolated-target-guard: ${status}`;
  if (status === "OK") { console.log(`${line} (kind=${kind}) — 격리 대상 확인됨(값은 출력하지 않음).${kind === "ephemeral-local-stack" ? " 일회용 로컬 Supabase 스택이며 호스팅 프로젝트가 아니다." : ""}`); process.exit(0); }
  console.log(line); for (const p of problems) console.log(`  - ${p}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { (await import("node:fs")).appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 격리 환경 게이트(#240): **${status}**\n${problems.map((p) => `- ${p}`).join("\n")}\n\n가드 판정이 OK 가 아니므로 이 실행의 fixture 생성과 live 테스트를 시작하지 않습니다. 공유 DEV·운영·다른 환경으로 대체하지 않습니다.\n`); } catch { /* 요약 기록 실패는 판정에 영향 없음 */ }
  }
  // ISOLATED_GATE_ALLOW_BLOCKED=1 은 BLOCKED(미구성)만 통과시킨다. FAILED 는 어떤 경우에도 실패 종료, PARTIAL 은 전체 게이트 미통과(3).
  if (status === "BLOCKED" && process.env.ISOLATED_GATE_ALLOW_BLOCKED === "1") { console.log("::warning::격리 환경 미구성(BLOCKED) — 전환 미완료"); process.exit(0); }
  process.exit(status === "PARTIAL" ? 3 : 1);
}
