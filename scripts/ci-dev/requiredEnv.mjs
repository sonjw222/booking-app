// CI/dev Supabase 필수 환경변수 이름(값 아님) — GitHub Secrets 이름과 1:1.
import { checkLiveEnv } from "../ci/liveEnvPreflight.mjs";

export const REQUIRED_SECRET_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "TEST_CENTER_ID", "TEST_PRODUCT_ID",
  "TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD", "TEST_USER_B_EMAIL", "TEST_USER_B_PASSWORD",
  "TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD", "TEST_MANAGER_B_EMAIL", "TEST_MANAGER_B_PASSWORD",
];
// TEST_STAFF_A/B는 현재 어떤 테스트도 읽지 않는다(acl-003 주석: "전용 스태프 계정 없이 MANAGER_A/B로 검증"; 스태프는 테스트가 inviteStaff로 직접 만든다).
// test.yml이 env로 넘기기만 하므로 Secrets는 없어도 된다 → 필수에서 제외.
export const FIXTURE_ACCOUNTS = ["USER_A", "USER_B", "MANAGER_A", "MANAGER_B"];

// 비-production hard guard + 필수 이름 누락 검사. { ok, problems } — 값은 절대 포함하지 않는다.
// seed가 "만들어 주는" 값(TEST_CENTER_ID/TEST_PRODUCT_ID)은 seed 단계에서는 필수가 아니다.
export const SEED_OUTPUT_NAMES = ["TEST_CENTER_ID", "TEST_PRODUCT_ID"];
export function checkCiDevEnv(env, { forSeed = false } = {}) {
  const { problems } = checkLiveEnv(env);
  for (const n of REQUIRED_SECRET_NAMES) { if (forSeed && SEED_OUTPUT_NAMES.includes(n)) continue; if (!String(env[n] ?? "").trim()) problems.push(`${n} 누락`); }
  return { ok: problems.length === 0, problems };
}
export function requireNonProductionOrExit(env = process.env, opts = {}) {
  const { ok, problems } = checkCiDevEnv(env, opts);
  if (!ok) { console.error("ci-dev: 중단 — 환경이 안전하지 않거나 불완전합니다."); for (const p of problems) console.error(`  - ${p}`); process.exit(1); }
}
