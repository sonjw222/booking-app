// 로컬 일회용 Supabase 가 아니면 어떤 네트워크 요청보다 먼저 중단한다(운영·공유 DEV·호스팅 주소, 호스팅 키, 형식 오류 거부).
// ISO_ENV_FILE(bootstrapEphemeral 형식)을 읽어 scripts/ci/isolatedTargetGuard.mjs 의 판정(OK + ephemeral-local-stack)을 요구한다. 값은 출력하지 않는다.
import fs from "node:fs";
import { checkIsolatedTarget } from "../../ci/isolatedTargetGuard.mjs";
export function loadIsolatedEnv(file) {
  if (!file) throw new Error("ISOLATED_GUARD: ISO_ENV_FILE 이 없어요 — 요청을 보내지 않고 중단");
  let raw; try { raw = fs.readFileSync(file, "utf8"); } catch { throw new Error("ISOLATED_GUARD: 환경 파일을 읽을 수 없어요 — 요청을 보내지 않고 중단"); }
  const env = Object.fromEntries(raw.trim().split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }));
  const g = checkIsolatedTarget({
    ISOLATED_KIND: "ephemeral-local-stack", ISOLATED_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, ISOLATED_SUPABASE_PROJECT_REF: "local:mwhabit-isolated",
    ISOLATED_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, ISOLATED_SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    PRODUCTION_SUPABASE_URL: env.PRODUCTION_SUPABASE_URL ?? "",
  });
  if (g.status !== "OK" || g.kind !== "ephemeral-local-stack") throw new Error(`ISOLATED_GUARD: 일회용 로컬 스택이 아니에요(판정 ${g.status}) — 요청을 보내지 않고 중단: ${g.problems.map((p) => p.replace(/https?:\/\/\S+/g, "<url>")).join("; ").slice(0, 200)}`);
  return env;
}
