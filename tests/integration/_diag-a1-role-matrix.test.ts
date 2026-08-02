/*
  일회성 진단(읽기 전용) — Batch A1(staff_salaries/leads/messages) 실제 승인 전 요청받은
  "현재 RLS/정책/GRANT 상태, 역할별 기대 결과표" 작성 근거를 라이브 dev Supabase에서
  직접 확인한다. mutation 없음(count-only head select만 사용) — 결과 확인 후 이 파일은 삭제한다.
*/
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getFixtureAdminClient, type TestUser } from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const TABLES = ["staff_salaries", "leads", "messages"];

let managerA: TestUser;

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
}, 30000);

function anonClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function probeSelect(label: string, client: any, table: string) {
  const { count, error } = await client.from(table).select("id", { count: "exact", head: true });
  // eslint-disable-next-line no-console
  console.log(`[DIAG-A1] ${label} SELECT ${table}: ${error ? `ERROR ${error.code ?? "?"} — ${error.message}` : `OK count=${count}`}`);
}

describe("DIAG-A1: 역할별 SELECT 결과(읽기 전용)", () => {
  it("anon", async () => {
    const anon = anonClient();
    for (const t of TABLES) await probeSelect("anon", anon, t);
  });
  it("authenticated (managerA, centerA 오너)", async () => {
    for (const t of TABLES) await probeSelect("authenticated(owner)", supabase, t);
  });
  it("service_role", async () => {
    const admin = getFixtureAdminClient();
    for (const t of TABLES) await probeSelect("service_role", admin, t);
  });
});
