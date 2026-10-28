// 로컬 격리 스택 전용(이슈 #239): 관리자 전 액션·역할별 QA 에 쓸 fixture 를 격리 DB 안에 만든다. 공유 DEV·운영에는 쓰지 않는다(격리 가드 통과 필수).
// 만드는 것: QA 센터 1(오너=TEST_MANAGER_A), 조회 전용 제한 직원 1, 권한 변경 대상 직원 1, 회원(TEST_USER_A, 센터 회원 등록·수강권 상품)·상품·쿠폰.
// 사용: ISO_ENV_FILE=… node seedAdminQa.mjs  (환경 파일에 QA_* 값을 덧붙인다 — 비밀번호 포함, 커밋 금지)
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const file = process.env.ISO_ENV_FILE; const env = loadIsolatedEnv(file);
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
const pwd = () => crypto.randomBytes(14).toString("base64url") + "Aa1!";
const acct = async (email, name, extra = {}) => { const password = pwd(); const u = await svc.auth.admin.createUser({ email, password, email_confirm: true }); if (u.error) throw new Error(u.error.message);
  const a = must(await svc.from("accounts").insert({ auth_id: u.data.user.id, name, is_member: true, is_manager: !!extra.is_manager, marketing_consent: false }).select("id").single(), "accounts");
  must(await svc.from("profiles").insert({ account_id: a.id, name, is_primary: true }), "profiles"); return { id: a.id, email, password }; };
const ownerAcc = must(await svc.from("accounts").select("id").eq("auth_id", (await svc.auth.admin.listUsers({ perPage: 200 })).data.users.find((u) => u.email === env.TEST_MANAGER_A_EMAIL).id).single(), "owner");
// QA 센터(승인·비내부 — INSERT 에는 상태 보호 트리거가 없다). 오너 역할은 트리거가 만든다.
const center = must(await svc.from("centers").insert({ name: "관리자QA센터", status: "approved", is_internal: false }).select("id").single(), "center");
const ownerRole = must(await svc.from("center_roles").select("id").eq("center_id", center.id).eq("is_owner", true).single(), "owner role");
must(await svc.from("manager_centers").insert({ account_id: ownerAcc.id, center_id: center.id, role_id: ownerRole.id, status: "active" }), "owner link");
// 조회 전용 제한 직원 역할 + 권한 변경 대상 역할
const mkRole = async (name, keys) => { const r = must(await svc.from("center_roles").insert({ center_id: center.id, name, is_system: false, is_owner: false }).select("id").single(), "role " + name);
  if (keys.length) must(await svc.from("role_permissions").insert(keys.map((k) => ({ role_id: r.id, permission_key: k }))), "role perms"); return r.id; };
const limitedKeys = ["customer.member.view", "schedule.other.group.view", "board.notice.view", "pass.goods.view", "pass.order.view", "facility.review.view", "facility.staff.view"];
const limitedRole = await mkRole("QA 조회 전용", limitedKeys); const targetRole = await mkRole("QA 변경 대상", ["customer.member.view"]);
const limited = await acct("ci-qa-limited@isolated.test", "QA 제한직원", { is_manager: true });
const target = await acct("ci-qa-target@isolated.test", "QA 변경대상직원", { is_manager: true });
must(await svc.from("manager_centers").insert({ account_id: limited.id, center_id: center.id, role_id: limitedRole, status: "active" }), "limited link");
must(await svc.from("manager_centers").insert({ account_id: target.id, center_id: center.id, role_id: targetRole, status: "active" }), "target link");
// 회원(TEST_USER_A): 센터 회원 등록
const userAcc = (await svc.auth.admin.listUsers({ perPage: 200 })).data.users.find((u) => u.email === env.TEST_USER_A_EMAIL);
const ua = must(await svc.from("accounts").select("id").eq("auth_id", userAcc.id).single(), "user a");
const prof = must(await svc.from("profiles").select("id").eq("account_id", ua.id).order("created_at").limit(1).single(), "profile");
must(await svc.from("center_members").insert({ center_id: center.id, profile_id: prof.id }), "center_members");
const prod = must(await svc.from("products").insert({ center_id: center.id, name: "QA 10회권", price: 100000, product_kind: "pass", pass_type: "count", total_count: 10, is_active: true, is_on_sale: true, visibility_type: "all", expiry_mode: "days", expiry_days: 90 }).select("id").single(), "product");
// 알림톡 발송 화면 fixture: 애드온 신청 상태 + 승인 템플릿 + 수신 가능한 회원 전화번호(전화 인증 보호 트리거는 로컬 fixture 한정으로 잠시 끈다)
psql(`update center_subscriptions set alimtalk_addon = true where center_id = '${center.id}'`);
psql(`insert into alimtalk_templates(center_id, aligo_template_code, title, content, variables, status, is_active) values ('${center.id}', 'TQA0001', 'QA 안내', '#{name}님 QA 안내입니다.', '{name}', 'approved', true)`);
psql(`update profiles set phone = '01012345678' where id = '${prof.id}'`);
psql(`alter table accounts disable trigger trg_accounts_phone_verified; update accounts set phone = '01012345678' where id = '${ua.id}'; alter table accounts enable trigger trg_accounts_phone_verified`);
fs.appendFileSync(file, `\nQA_CENTER_ID=${center.id}\nQA_PRODUCT_ID=${prod.id}\nQA_MEMBER_PROFILE_ID=${prof.id}\nQA_LIMITED_EMAIL=${limited.email}\nQA_LIMITED_PASSWORD=${limited.password}\nQA_TARGET_EMAIL=${target.email}\nQA_TARGET_PASSWORD=${target.password}\nQA_TARGET_ACCOUNT_ID=${target.id}\nQA_TARGET_ROLE_ID=${targetRole}\n`);
console.log("seed OK", JSON.stringify({ center: center.id.slice(0, 8), product: prod.id.slice(0, 8) }));
