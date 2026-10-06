#!/usr/bin/env node
// READ-ONLY 검증: service role로 SELECT만 수행. Production이면 시작 전에 중단. 사용: npm run ci:dev:verify
import { requireNonProductionOrExit, FIXTURE_ACCOUNTS } from "./requiredEnv.mjs";
requireNonProductionOrExit(process.env);
const base = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, ""), key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const get = async (path) => { const r = await fetch(`${base}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }); return { status: r.status, body: r.ok ? await r.json() : null }; };
const rows = [];
const check = (name, ok, hint = "") => { rows.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !hint ? "" : "  → " + hint}`); };

const c = await get(`centers?select=id&id=eq.${encodeURIComponent(process.env.TEST_CENTER_ID)}`);
check("TEST_CENTER_ID 센터 존재", c.body?.length === 1, "schema/seed 적용 여부 확인");
const p = await get(`products?select=id,center_id&id=eq.${encodeURIComponent(process.env.TEST_PRODUCT_ID)}`);
check("TEST_PRODUCT_ID 상품이 TEST_CENTER_ID 소속", p.body?.length === 1 && p.body[0].center_id === process.env.TEST_CENTER_ID);
const ur = await fetch(`${base}/auth/v1/admin/users?per_page=1000`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
const emails = new Set(ur.ok ? ((await ur.json()).users ?? []).map((u) => String(u.email).toLowerCase()) : []);
for (const a of FIXTURE_ACCOUNTS) check(`fixture 계정 ${a} 존재(auth)`, emails.has(String(process.env[`TEST_${a}_EMAIL`]).toLowerCase()), "npm run ci:dev:seed 또는 수동 생성");
const failed = rows.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exit(failed ? 1 : 0);
