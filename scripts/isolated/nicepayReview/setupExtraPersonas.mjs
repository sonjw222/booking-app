// 로컬 격리 DB 전용: (T) 토스 심사 계정 = pg_checkout_override 만 true 인 일반 회원, (S) 운영 심사관 후보와 같은 형태 = is_member=false·매니저·기존 토스 심사 센터(내부 센터) 매니저·nicepay_review_access.
// 계정 비밀번호는 실행마다 새로 만들어 ISO_ENV_FILE 에 추가한다(0600, 커밋 금지). 운영 계정 데이터는 사용하지 않는다.
import fs from "node:fs"; import crypto from "node:crypto";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE);
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const pwd = () => crypto.randomBytes(16).toString("base64url") + "Aa1!";
const add = [];
async function mk(tag, email, name) {
  const password = pwd(); const ex = (await svc.auth.admin.listUsers()).data.users.find((u) => u.email === email);
  let id = ex?.id; if (!ex) id = (await svc.auth.admin.createUser({ email, password, email_confirm: true })).data.user.id; else await svc.auth.admin.updateUserById(id, { password });
  await new Promise((r) => setTimeout(r, 600));
  let { data: acc } = await svc.from("accounts").select("id").eq("auth_id", id).maybeSingle();
  if (!acc) acc = (await svc.from("accounts").insert({ auth_id: id, name }).select("id").single()).data;
  const { data: pr } = await svc.from("profiles").select("id").eq("account_id", acc.id).limit(1);
  if (!pr?.length) { const r = await svc.from("profiles").insert({ account_id: acc.id, name, is_primary: true }); if (r.error) throw new Error("profile: " + r.error.message); }
  add.push(`${tag}_EMAIL=${email}`, `${tag}_PASSWORD=${password}`); return acc.id;
}
const t = await mk("TOSS_REVIEWER", "ci-toss-reviewer@isolated.test", "토스 심사 계정(로컬)");
await svc.from("accounts").update({ pg_checkout_override: true }).eq("id", t);
const s = await mk("SONJW_LIKE", "ci-sonjw-like@isolated.test", "[토스 심사용] 모하빗 리뷰 계정(로컬)");
await svc.from("accounts").update({ is_member: false, is_manager: true, nicepay_review_access: true }).eq("id", s);
let { data: tc } = await svc.from("centers").select("id").eq("name", "[토스 심사용] 로컬 시험 센터").maybeSingle();
if (!tc) {
  tc = (await svc.from("centers").insert({ name: "[토스 심사용] 로컬 시험 센터", status: "approved", is_internal: true }).select("id").single()).data;
  await svc.from("center_settings").insert({ center_id: tc.id });
  await svc.from("products").insert({ center_id: tc.id, name: "체험 수강권 10회", price: 200000, product_kind: "pass", pass_type: "count", total_count: 10, expiry_mode: "days", expiry_days: 90, is_active: true, is_on_sale: true, visibility_type: "all" });
  await svc.from("manager_centers").insert({ account_id: s, center_id: tc.id, status: "active" });
  const { data: tprof } = await svc.from("profiles").select("id").eq("account_id", t).limit(1); await svc.from("center_members").insert({ center_id: tc.id, profile_id: tprof[0].id });
}
fs.appendFileSync(process.env.ISO_ENV_FILE, add.join("\n") + "\n");
console.log("extra personas OK (T: pg_checkout_override only / S: is_member=false·manager of internal Toss-like center·nicepay_review_access)");
