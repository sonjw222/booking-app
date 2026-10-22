/* tests/rls-real 공용: 격리 PostgREST용 JWT/클라이언트와 시드 ID. 시드 SQL(10_seed.sql)과 같은 UUID. 운영·공유 DEV 접속 없음. */
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const URL_ = process.env.RLS_REST_URL ?? "http://127.0.0.1:3203";
const SECRET = "qa-secret-qa-secret-qa-secret-1234567890";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const jwt = (role: string, sub?: string) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64({ role, iss: "qa", exp: 4102444800, ...(sub ? { sub, aud: "authenticated" } : {}) }); return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`; };
export const U = { A: "11111111-1111-1111-1111-111111111111", B: "22222222-2222-2222-2222-222222222222", M: "33333333-3333-3333-3333-333333333333" };
export const ID = {
  centerPub: "c0a00000-0000-0000-0000-00000000c0a0", centerPriv: "c0b00000-0000-0000-0000-00000000c0b0",
  pA1: "a1000000-0000-0000-0000-0000000000a1", pA2: "a2000000-0000-0000-0000-0000000000a2", pB1: "b1000000-0000-0000-0000-0000000000b1",
  prodFree: "e1000000-0000-0000-0000-0000000000e1", prodOther: "e2000000-0000-0000-0000-0000000000e2",
  memB: "f2000000-0000-0000-0000-0000000000f2",
};
export function clientFor(sub: string | null): SupabaseClient {
  const rootFetch: typeof fetch = (input, init) => fetch(String(input).replace("/rest/v1/", "/"), init);
  return createClient(URL_, jwt("anon"), { global: { fetch: rootFetch, headers: sub ? { Authorization: `Bearer ${jwt("authenticated", sub)}` } : {} }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
/** 시드/상태 준비 전용(권한 검증이 아님) — 로컬 격리 DB 컨테이너에만 접속한다. */
export const sql = (q: string) => execFileSync("docker", ["exec", "qa-rls-pg", "psql", "-U", "postgres", "-d", "qa", "-tAc", q], { encoding: "utf8" }).trim();
export const kstDay = (offsetDays: number, hour: number, minute = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400_000); const ymd = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(d);
  return new Date(`${ymd}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`).toISOString();
};
