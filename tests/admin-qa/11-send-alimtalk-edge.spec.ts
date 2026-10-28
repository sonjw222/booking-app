import http from "node:http";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { test, expect, need, QA_CENTER_ID } from "./helpers";

/* 실제 Edge Function(send-alimtalk, 로컬 격리 스택의 edge-runtime) 권한 검증. 응답을 가로채지 않는다 — 함수가 진짜로 판정하고, 외부 전송은 "로컬 대체 서버"(알리고 프록시 스텁)로만 갈 수 있다.
   스택 설정(scripts/isolated/adminQa/secondStack.sh)이 ALIGO_PROXY_URL 을 http://host.docker.internal:54999 로 지정한다. 스텁이 받은 요청 수 = 외부 발송 제공자 호출 수. */
test.describe.configure({ mode: "serial" });
const URL_ = need("NEXT_PUBLIC_SUPABASE_URL"); const ANON = need("NEXT_PUBLIC_SUPABASE_ANON_KEY"); const SERVICE = need("SUPABASE_SERVICE_ROLE_KEY");
const FN = `${URL_}/functions/v1/send-alimtalk`;
const DB = process.env.ISO_DB_CONTAINER ?? "supabase_db_mwhabit-isolated";
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();

const hits: Array<{ path: string; auth: string | undefined; body: string }> = [];
let stub: http.Server;
test.beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      hits.push({ path: req.url ?? "", auth: req.headers.authorization, body: b });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ provider: req.url?.includes("alimtalk") ? { code: 0, info: { mid: "stub-mid" } } : { result_code: "1", msg_id: "stub-msg" } }));   // 프록시 계약: { provider: … }
    });
  });
  await new Promise<void>((ok, bad) => { stub.once("error", bad); stub.listen(54999, "0.0.0.0", ok); });
});
test.afterAll(async () => { await new Promise((ok) => stub.close(ok)); });
test.beforeEach(() => { hits.length = 0; });

async function jwtFor(emailKey: string, pwKey: string): Promise<{ token: string; email: string }> {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email: need(emailKey), password: need(pwKey) });
  if (error || !data.session) throw new Error(`로그인 실패: ${error?.message}`);
  // 유효한 사용자 JWT 임을 먼저 확인(401 을 권한 차단 성공으로 세지 않기 위해)
  const me = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${data.session.access_token}` } });
  expect(me.status, "사용자 JWT 가 유효해야 함").toBe(200);
  expect((await me.json()).email).toBe(need(emailKey));
  return { token: data.session.access_token, email: need(emailKey) };
}
const call = async (token: string, body: Record<string, unknown>) => {
  const res = await fetch(FN, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let json: Record<string, unknown> = {}; try { json = await res.json(); } catch { /* 본문 없음 */ }
  return { status: res.status, json };
};
const SMS = () => ({ to: "01099999999", content: "QA 권한 확인(로컬 대체 서버로만 전달)", channel: "alimtalk", centerId: QA_CENTER_ID() });

test("[제한직원] 유효한 JWT 로 직접 호출 → 정확히 403, 외부 발송 제공자(스텁) 호출 0건", async () => {
  const { token } = await jwtFor("QA_LIMITED_EMAIL", "QA_LIMITED_PASSWORD");
  const r = await call(token, SMS());
  expect(r.status, JSON.stringify(r.json)).toBe(403);
  expect(String(r.json.error)).toContain("권한");
  const t = await call(token, { action: "list_templates", centerId: QA_CENTER_ID() });
  expect(t.status, "템플릿 목록(외부 조회)도 같은 권한").toBe(403);
  expect(hits).toHaveLength(0);
});

test("[익명 키] 로그인 사용자가 아닌 JWT → 401(권한 차단 403 과 구분), 스텁 0건", async () => {
  const r = await call(ANON, SMS());
  expect(r.status, JSON.stringify(r.json)).toBe(401);
  expect(hits).toHaveLength(0);
});

test("[오너] 권한 조회 오류(has_permission 실행 불가) → fail-closed 500, 스텁 0건 — 끝나면 권한 원복", async () => {
  const { token } = await jwtFor("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  const sig = "public.has_permission(uuid,text)";
  const had = (role: string) => psql(`select has_function_privilege('${role}', '${sig}', 'execute')`) === "t";
  const roles = ["authenticated", "anon", "public"].filter(had);
  try {
    psql(`revoke execute on function ${sig} from public, anon, authenticated`);
    const r = await call(token, SMS());
    expect(r.status, JSON.stringify(r.json)).toBe(500);
    expect(hits).toHaveLength(0);
  } finally {
    for (const role of roles) psql(`grant execute on function ${sig} to ${role === "public" ? "public" : role}`);
  }
  expect(psql(`select has_function_privilege('authenticated', '${sig}', 'execute')`)).toBe("t");
});

test("[오너] 정상 권한 → 200 + 스텁이 SMS 요청 정확히 1건(대체 서버로만 전달)", async () => {
  const { token } = await jwtFor("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  const r = await call(token, SMS());
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.status).toBe("sent");
  expect(hits).toHaveLength(1);
  expect(hits[0].path).toBe("/v1/sms/send"); expect(hits[0].auth).toBe("Bearer local-stub-token-not-a-secret");
  expect(JSON.parse(hits[0].body)).toMatchObject({ to: "01099999999" });
});

test("[service_role] 내부 호출 경로 유지 → 200 + 스텁 1건", async () => {
  const r = await call(SERVICE, SMS());
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(hits).toHaveLength(1);
});
