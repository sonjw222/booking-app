// 로컬 격리 스택 전용(이슈 #238): 관리자 센터 페이지네이션 러너의 전제(기존 플랫폼 관리자 + 상태별 31건 이상 센터)를 "격리 DB 안에" 만든다.
// 공유 DEV·운영에는 쓰지 않는다 — 격리 가드(isolatedTargetGuard) 통과가 아니면 중단. 사용: ISO_ENV_FILE=… node seedAdminPagination.mjs  (환경 파일에 TEST_PLATFORM_ADMIN_* 를 덧붙인다)
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const file = process.env.ISO_ENV_FILE; const env = loadIsolatedEnv(file);
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = "ci-platform-admin@isolated.test", password = crypto.randomBytes(12).toString("base64url") + "Aa1!";
const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true }); if (error) throw new Error(error.message);
const ins = await svc.from("accounts").insert({ auth_id: data.user.id, name: "플랫폼 관리자(격리)", is_member: true, is_manager: false, is_platform_admin: true, marketing_consent: false }); if (ins.error) throw new Error(ins.error.message);
await svc.from("profiles").insert({ account_id: (await svc.from("accounts").select("id").eq("auth_id", data.user.id).single()).data.id, name: "플랫폼 관리자(격리)", is_primary: true });
// 상태별 센터: 승인대기 31(같은 created_at 동률 5건 포함 — 30/31 경계), 승인됨 30, 반려됨 61(30+30+1)
const tie = "2026-09-01 10:00:00+09";
psql(`insert into centers(name, status, created_at) select '페이지 센터 대기 ' || g, 'pending', case when g <= 5 then timestamptz '${tie}' else timestamptz '2026-08-01 00:00:00+09' + (g || ' minutes')::interval end from generate_series(1, 31) g;
      insert into centers(name, status, created_at) select '페이지 센터 승인 ' || g, 'approved', timestamptz '2026-07-01 00:00:00+09' + (g || ' minutes')::interval from generate_series(1, 30) g;
      insert into centers(name, status, created_at) select '페이지 센터 반려 ' || g, 'rejected', timestamptz '2026-06-01 00:00:00+09' + (g || ' minutes')::interval from generate_series(1, 61) g;`);
fs.appendFileSync(file, `\nTEST_PLATFORM_ADMIN_EMAIL=${email}\nTEST_PLATFORM_ADMIN_PASSWORD=${password}\n`);
console.log("seed OK:", psql("select status||'='||count(*) from centers group by status order by 1").replace(/\n/g, ", "));
