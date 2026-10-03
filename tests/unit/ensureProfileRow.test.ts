/* ensureProfileRow(): "살아 있는 대표 프로필(is_primary=true, deleted_at is null)" 기준으로 존재 판정 — in-memory fake, Production 데이터 사용 없음. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("sessionStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });

type Row = Record<string, any>;
const db: { accounts: Row[]; profiles: Row[] } = { accounts: [], profiles: [] };
const inserts: Row[] = []; const updates: { table: string; patch: Row }[] = []; const deletes: string[] = [];
let currentUser: any = null; let seq = 0;
function from(table: "accounts" | "profiles") {
  let op: "select" | "update" | "insert" = "select"; let patch: Row = {}; let ins: Row = {}; const filters: ((r: Row) => boolean)[] = [];
  const run = (mode: "many" | "maybe" | "single") => {
    const matched = db[table].filter((r) => filters.every((f) => f(r)));
    if (op === "update") { updates.push({ table, patch }); for (const r of matched) Object.assign(r, patch); return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null }); }
    if (op === "insert") { const row = { id: `${table}-${++seq}`, deleted_at: null, is_primary: false, ...ins }; inserts.push({ table, ...ins }); db[table].push(row); return Promise.resolve({ data: mode === "many" ? [row] : row, error: null }); }
    return Promise.resolve({ data: mode === "many" ? matched : (matched[0] ?? null), error: null });
  };
  const api: any = {
    select() { return api; }, update(p: Row) { op = "update"; patch = p; return api; }, insert(r: Row) { op = "insert"; ins = r; return api; },
    delete() { deletes.push(table); return api; },
    eq(c: string, v: any) { filters.push((r) => r[c] === v); return api; }, is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return api; }, limit() { return api; },
    maybeSingle() { return run("maybe"); }, single() { return run("single"); }, then(res: any, rej: any) { return run("many").then(res, rej); },
  };
  return api;
}
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (t: any) => from(t),
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
    rpc: async (name: string) => (name === "my_account_id" ? { data: db.accounts.find((a) => a.auth_id === currentUser?.id)?.id ?? null, error: null } : { data: null, error: null }),
  },
}));
import { ensureAccountForCurrentUser } from "../../lib/authAccount";

const user = { id: "auth-1", email: "홍@example.com", app_metadata: { provider: "google" }, user_metadata: {} };
const seed = (profiles: Row[]) => {
  db.accounts = [{ id: "acc-1", auth_id: "auth-1", name: "홍길동", phone: "01012345678", address: "서울", marketing_consent: true }];
  db.profiles = profiles.map((p, i) => ({ id: `p-${i + 1}`, account_id: "acc-1", deleted_at: null, ...p }));
};
const profileInserts = () => inserts.filter((i) => i.table === "profiles");
beforeEach(() => { mem.clear(); db.accounts = []; db.profiles = []; inserts.length = 0; updates.length = 0; deletes.length = 0; seq = 0; currentUser = user; });

describe("ensureProfileRow — 대표 프로필 존재 판정", () => {
  it("1. 프로필이 하나도 없으면 is_primary=true 프로필을 만든다(기존 동작 유지, accounts 이름 사용)", async () => {
    seed([]);
    await ensureAccountForCurrentUser();
    expect(profileInserts()).toEqual([{ table: "profiles", account_id: "acc-1", name: "홍길동", is_primary: true }]);
  });
  it("2. 추가 프로필(is_primary=false, 살아 있음)만 있으면 기존 프로필은 그대로 두고 별도의 is_primary=true 프로필을 만든다(승격/수정/삭제 없음)", async () => {
    seed([{ name: "자녀", label: "아이", is_primary: false }]);
    await ensureAccountForCurrentUser();
    expect(profileInserts()).toEqual([{ table: "profiles", account_id: "acc-1", name: "홍길동", is_primary: true }]);
    const child = db.profiles.find((p) => p.id === "p-1")!;
    expect(child).toMatchObject({ name: "자녀", label: "아이", is_primary: false, deleted_at: null });   // 이름/라벨/primary 불변
    expect(updates.filter((u) => u.table === "profiles")).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    expect(db.profiles.filter((p) => p.is_primary && p.deleted_at === null)).toHaveLength(1);
  });
  it("3. 살아 있는 대표 프로필이 있으면 insert하지 않는다", async () => {
    seed([{ name: "홍길동", is_primary: true }]);
    await ensureAccountForCurrentUser();
    expect(profileInserts()).toHaveLength(0);
  });
  it("4. 삭제된(deleted_at != null) 대표 프로필만 있으면 살아 있는 대표로 보지 않고 새 primary를 만든다(삭제된 행은 건드리지 않음)", async () => {
    seed([{ name: "삭제됨", is_primary: true, deleted_at: "2026-01-01T00:00:00Z" }]);
    await ensureAccountForCurrentUser();
    expect(profileInserts()).toHaveLength(1);
    expect(db.profiles.find((p) => p.id === "p-1")).toMatchObject({ name: "삭제됨", is_primary: true, deleted_at: "2026-01-01T00:00:00Z" });
    expect(db.profiles.filter((p) => p.is_primary && p.deleted_at === null)).toHaveLength(1);
  });
  it("5. 추가 프로필 + 살아 있는 대표 프로필이 함께 있으면 아무것도 추가하지 않는다", async () => {
    seed([{ name: "자녀", is_primary: false }, { name: "홍길동", is_primary: true }]);
    await ensureAccountForCurrentUser();
    expect(profileInserts()).toHaveLength(0);
    expect(updates.filter((u) => u.table === "profiles")).toHaveLength(0);
  });
  it("복구 후 반복 호출은 멱등(두 번째부터 insert 없음), accounts의 name/phone/address/동의 값은 변경하지 않는다", async () => {
    seed([{ name: "자녀", is_primary: false }]);
    await ensureAccountForCurrentUser(); await ensureAccountForCurrentUser();
    expect(profileInserts()).toHaveLength(1);
    expect(db.accounts[0]).toMatchObject({ name: "홍길동", phone: "01012345678", address: "서울", marketing_consent: true });
    expect(updates.filter((u) => u.table === "accounts")).toHaveLength(0);
  });
  it("소셜 이름 복구 우선순위는 그대로: 새로 만든 대표 프로필 이름이 accounts의 정상 이름이면 provider 후보로 덮어쓰지 않는다", async () => {
    seed([{ name: "자녀", is_primary: false }]);
    mem.set("social_name_candidate_v1", JSON.stringify({ provider: "google", name: "구글이름", autoSave: true, at: Date.now() }));
    const r = (await ensureAccountForCurrentUser())!;
    expect(r.name).toBe("홍길동");
    expect(db.profiles.find((p) => p.is_primary)!.name).toBe("홍길동");
    expect(db.profiles.find((p) => p.id === "p-1")!.name).toBe("자녀");
  });
});
