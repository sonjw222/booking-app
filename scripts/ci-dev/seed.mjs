#!/usr/bin/env node
// fixture 인증 계정 생성(멱등). 비-production 가드 통과 + CI_DEV_SEED_ACK=1 필요. 센터/상품/역할 행은 docs/CI_DEV_SUPABASE_SETUP.md의 수동 단계.
import { requireNonProductionOrExit, FIXTURE_ACCOUNTS } from "./requiredEnv.mjs";
requireNonProductionOrExit(process.env);
if (process.env.CI_DEV_SEED_ACK !== "1") { console.error("ci-dev seed: CI_DEV_SEED_ACK=1 을 설정해야 실행됩니다(비-production 프로젝트 확인 후)."); process.exit(1); }
const base = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, ""), key = process.env.SUPABASE_SERVICE_ROLE_KEY;
for (const a of FIXTURE_ACCOUNTS) {
  const email = process.env[`TEST_${a}_EMAIL`], password = process.env[`TEST_${a}_PASSWORD`];
  const r = await fetch(`${base}/auth/v1/admin/users`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
  console.log(`${a}: ${r.ok ? "created" : r.status === 422 ? "already exists (skip)" : `HTTP ${r.status}`}`);
}
