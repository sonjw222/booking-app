// 로컬 격리 스택 전용(ISO_ENV_FILE = bootstrapEphemeral 가 쓴 환경 파일, 0600·커밋 금지). 운영/공유 DEV 로 실행하지 않는다. 사용법: docs/payments/NICEPAY_REVIEW_CENTER_20261028.md §6

import { createRequire } from "node:module"; import fs from "node:fs";
const require = createRequire(process.cwd() + "/package.json");
const { createClient } = require("@supabase/supabase-js");
const env = Object.fromEntries(fs.readFileSync(process.env.ISO_ENV_FILE, "utf8").trim().split("\n").map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: centers } = await svc.from("centers").select("id,name,is_nicepay_review"); const REV = centers.find((c) => c.is_nicepay_review), OP = centers.find((c) => c.name === "[QA] 심사 시험 스튜디오");
const mk = async (center, title) => (await svc.from("classes").insert({ center_id: center.id, title, start_time: new Date(Date.now() + 3 * 864e5).toISOString(), end_time: new Date(Date.now() + 3 * 864e5 + 36e5).toISOString(), capacity: 10 }).select("id").single()).data.id;
const revC = await mk(REV, "[심사용] 예약시험"), opC = await mk(OP, "[QA] 예약시험");
// 서비스 롤로 각 센터에 수강권을 줘서(트리거 미적용 경로) 예약 단계까지 도달시킨다
const { data: prof } = await svc.from("profiles").select("id,account_id"); const { data: accs } = await svc.from("accounts").select("id,auth_id"); const { data: users } = await svc.auth.admin.listUsers();
const pidOf = (email) => { const u = users.users.find((x) => x.email === email); const a = accs.find((x) => x.auth_id === u.id); return prof.find((p) => p.account_id === a.id).id; };
const who = { "일반회원(A)": [env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD], "심사관(B)": [env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD] };
const res = {};
for (const [n, [e, pw]] of Object.entries(who)) {
  const pid = pidOf(e);
  for (const [cn, ctr] of [["심사센터", REV], ["운영센터", OP]]) await svc.from("memberships").insert({ profile_id: pid, center_id: ctr.id, product_name: "시험", pass_type: "count", total_count: 5, remaining_count: 5 });
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email: e, password: pw });
  const r1 = await c.rpc("reserve_class", { p_class_id: revC, p_profile_id: pid }); const r2 = await c.rpc("reserve_class", { p_class_id: opC, p_profile_id: pid });
  res[n] = { 심사센터수업: r1.error ? "DENY/ERR: " + r1.error.message.slice(0, 60) : "예약 성공", 운영센터수업: r2.error ? "DENY/ERR: " + r2.error.message.slice(0, 60) : "예약 성공" };
}
console.log(JSON.stringify(res, null, 1));
