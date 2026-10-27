// 로컬 격리 스택 전용(ISO_ENV_FILE = bootstrapEphemeral 가 쓴 환경 파일, 0600·커밋 금지). 운영/공유 DEV 로 실행하지 않는다. 사용법: docs/payments/NICEPAY_REVIEW_CENTER_20261028.md §6

import { createRequire } from "node:module"; import fs from "node:fs";
const require = createRequire(process.cwd() + "/package.json");
const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE);   // 어떤 네트워크 요청보다 먼저: 일회용 로컬 스택이 아니면 여기서 throw
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const OP = (await svc.from("centers").select("id").eq("name", "[QA] 심사 시험 스튜디오").single()).data.id;
const mk = async (e, p) => { const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } }); await c.auth.signInWithPassword({ email: e, password: p }); return c; };
const ma = await mk(env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD), ua = await mk(env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD);
const r1 = await ma.from("centers").update({ is_nicepay_review: true }).eq("id", OP).select("id"); console.log("매니저가 자기 센터를 심사센터로 변경:", r1.error ? "DENY " + r1.error.message : "허용됨(문제)");
const r2 = await ma.from("centers").insert({ name: "x-review", is_nicepay_review: true }); console.log("매니저가 심사센터 생성:", r2.error ? "DENY " + r2.error.message : "허용됨(문제)");
const r3 = await ua.from("accounts").update({ pg_checkout_override: true }).eq("auth_id", (await ua.auth.getUser()).data.user.id); console.log("회원이 스스로 심사관 지정(기존 보호):", r3.error ? "DENY " + r3.error.message : "허용됨(문제)");
console.log("최종 op center flag:", (await svc.from("centers").select("is_nicepay_review").eq("id", OP).single()).data.is_nicepay_review);
