/*
  PERF-035: 관리자 회원 목록 확장성 — PostgREST 흉내 fixture(최대 1000행 + .in() URL 길이 제한)로
  50/500/1,000/1,001/2,000/5,000/20,000명에서 누락·중복·정렬·상태·전화 권한·센터 분리·요청 수를 검증한다.
  실제 DB/네트워크는 쓰지 않는다(모두 로컬 메모리).
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const MAX_ROWS_DEFAULT = 1000;
const URL_LIMIT = 8000;   // 일반적인 프록시/서버 요청 URL 한도를 보수적으로 흉내

type Row = Record<string, any>;
const state = {
  tables: {} as Record<string, Row[]>,
  maxRows: MAX_ROWS_DEFAULT,
  canPhone: true,
  membershipError: null as string | null,
  dropLastOfPageTwo: false,
  log: [] as { table: string; kind: "select" | "rpc"; urlLen: number; rows: number; error: boolean }[],
  inFlight: 0,
  maxInFlight: 0,
};

function cmp(a: any, b: any, asc: boolean): number {
  if (a == null && b == null) return 0;
  if (a == null) return asc ? 1 : -1;      // PostgreSQL: ASC는 NULLS LAST, DESC는 NULLS FIRST
  if (b == null) return asc ? -1 : 1;
  const r = a < b ? -1 : a > b ? 1 : 0;
  return asc ? r : -r;
}
async function latency<T>(fn: () => T): Promise<T> {
  state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
  await new Promise((r) => setTimeout(r, 0));
  state.inFlight--;
  return fn();
}

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from(table: string) {
      let selectStr = "";
      let wantCount = false;
      const eqs: [string, any][] = [];
      const ins: [string, string[]][] = [];
      const orders: [string, boolean][] = [];
      let range: [number, number] | null = null;
      let limitN: number | null = null;
      const chain: any = {
        select(s: string, o?: { count?: string }) { selectStr = s; wantCount = o?.count === "exact"; return chain; },
        eq(c: string, v: any) { eqs.push([c, v]); return chain; },
        in(c: string, v: string[]) { ins.push([c, v]); return chain; },
        order(c: string, o?: { ascending?: boolean }) { orders.push([c, o?.ascending !== false]); return chain; },
        range(a: number, b: number) { range = [a, b]; return chain; },
        limit(n: number) { limitN = n; return chain; },
        then(res: any, rej: any) {
          const urlLen = 40 + table.length + selectStr.length + eqs.map((e) => `&${e[0]}=eq.${e[1]}`).join("").length
            + ins.map(([c, v]) => `&${c}=in.(${v.join(",")})`).join("").length
            + orders.map((o) => `${o[0]}.${o[1] ? "asc" : "desc"}`).join(",").length;
          return latency(() => {
            const entry = { table, kind: "select" as const, urlLen, rows: 0, error: false };
            state.log.push(entry);
            if (urlLen > URL_LIMIT) { entry.error = true; return { data: null, error: { message: "Bad Request: URI too long" }, count: null }; }
            if (table === "memberships" && state.membershipError) { entry.error = true; return { data: null, error: { message: state.membershipError }, count: null }; }
            let rows = (state.tables[table] ?? []).filter((r) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, v]) => v.includes(r[c])));
            for (const [c, asc] of [...orders].reverse()) rows = [...rows].sort((a, b) => cmp(a[c], b[c], asc));
            const total = rows.length;
            let cap = state.maxRows;
            if (limitN != null) cap = Math.min(cap, limitN);
            let out = rows;
            if (range) out = rows.slice(range[0], Math.min(range[1] + 1, range[0] + cap));
            else out = rows.slice(0, cap);
            if (state.dropLastOfPageTwo && range && range[0] > 0 && out.length > 1) out = out.slice(0, -1);   // 조회 중 삭제로 페이지가 밀린 상황
            entry.rows = out.length;
            return { data: out, error: null, count: wantCount ? total : null };
          }).then(res, rej);
        },
      };
      return chain;
    },
    async rpc(name: string, args: { p_profile_ids: string[]; p_center_id: string }) {
      return latency(() => {
        const urlLen = 0;
        const entry = { table: name, kind: "rpc" as const, urlLen, rows: 0, error: false };
        state.log.push(entry);
        const members = state.tables.center_members.filter((m) => m.center_id === args.p_center_id);
        const inCenter = new Set(members.map((m) => m.profile_id));
        const rows = args.p_profile_ids.filter((id) => inCenter.has(id)).map((id) => ({
          profile_id: id, account_phone: state.canPhone ? `010-0000-${id.slice(-4)}` : null, profile_phone: null,
        })).slice(0, state.maxRows);
        entry.rows = rows.length;
        return { data: rows, error: null };
      });
    },
  },
}));

import { fetchMembers } from "../../lib/members";

const uuid = (prefix: string, i: number) => `${prefix}${String(i).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`.slice(0, 36);
const TODAY = new Date().toISOString().slice(0, 10);
const FUTURE = "2099-12-31";
const PAST = "2000-01-01";

type Expect = { id: string; status: "active" | "expired" | "dormant"; hasPass: boolean; address: string };

/** 회원 n명 + 다른 센터 회원 일부. 등록일은 일부러 대량 동률(10분 단위)로 만들어 정렬 안정성을 시험한다. */
function seed(n: number): Expect[] {
  const cm: Row[] = []; const prof: Row[] = []; const ms: Row[] = []; const exp: Expect[] = [];
  for (let i = 0; i < n; i++) {
    const pid = uuid("a", i);
    const address = `주소${i}`;
    const dormant = i % 7 === 0;
    cm.push({
      id: uuid("c", i), center_id: "c1", profile_id: pid, grade_id: null, status: dormant ? "dormant" : "active",
      registered_at: `2026-01-01T00:${String(Math.floor(i / 50) % 60).padStart(2, "0")}:00Z`, last_attended_at: null, app_linked: true, memo: null,
      profiles: { name: `회원${i}`, accounts: { address } }, member_grades: null,
    });
    prof.push({ id: pid, accounts: { address } });
    const kind = i % 3;   // 0: 수강권 없음, 1: 이용 가능(+만료권 1개), 2: 만료/소진만(2개)
    let hasUsable = false; let hasAny = false;
    if (kind === 1) {
      ms.push({ id: uuid("m", i * 3), center_id: "c1", profile_id: pid, product_name: "만료권", remaining_count: 0, expires_at: PAST, pass_type: "count", status: "active" });
      ms.push({ id: uuid("m", i * 3 + 1), center_id: "c1", profile_id: pid, product_name: "정상권", remaining_count: 5, expires_at: FUTURE, pass_type: "count", status: "active" });
      hasUsable = true; hasAny = true;
    } else if (kind === 2) {
      ms.push({ id: uuid("m", i * 3), center_id: "c1", profile_id: pid, product_name: "소진권", remaining_count: 0, expires_at: FUTURE, pass_type: "count", status: "active" });
      ms.push({ id: uuid("m", i * 3 + 1), center_id: "c1", profile_id: pid, product_name: "기간만료", remaining_count: null, expires_at: PAST, pass_type: "period", status: "active" });
      hasAny = true;
    }
    exp.push({ id: uuid("c", i), status: dormant ? "dormant" : hasUsable ? "active" : "expired", hasPass: hasAny, address });
  }
  // 다른 센터(분리 검증): 같은 규모의 별도 회원 + 이 센터 회원 profile에 대한 다른 센터 수강권(섞이면 안 됨)
  for (let i = 0; i < Math.min(n, 300); i++) {
    cm.push({ id: uuid("x", i), center_id: "c2", profile_id: uuid("b", i), grade_id: null, status: "active", registered_at: "2026-02-01T00:00:00Z", last_attended_at: null, app_linked: true, memo: null, profiles: { name: `타센터${i}`, accounts: { address: "타" } }, member_grades: null });
    ms.push({ id: uuid("y", i), center_id: "c2", profile_id: uuid("a", i), product_name: "타센터권", remaining_count: 9, expires_at: FUTURE, pass_type: "count", status: "active" });
  }
  state.tables = { center_members: cm, profiles: prof, memberships: ms };
  void TODAY;
  return exp;
}

beforeEach(() => {
  state.maxRows = MAX_ROWS_DEFAULT; state.canPhone = true; state.membershipError = null; state.dropLastOfPageTwo = false;
  state.log = []; state.inFlight = 0; state.maxInFlight = 0;
});

const SIZES = [50, 500, 1000, 1001, 2000, 5000, 20000];

describe("회원 목록 확장성 (PostgREST 1000행 상한 + URL 길이 제한 fixture)", () => {
  for (const n of SIZES) {
    it(`${n}명: 누락/중복 없음, 정렬 안정, 상태·주소·전화 정확, URL 한도 준수, 센터 분리`, async () => {
      const exp = seed(n);
      const list = await fetchMembers("c1");
      expect(list.length).toBe(n);
      expect(new Set(list.map((m) => m.id)).size).toBe(n);
      // registered_at desc, id desc (안정 키)
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1]; const b = list[i];
        expect(a.registeredAt > b.registeredAt || (a.registeredAt === b.registeredAt && a.id > b.id)).toBe(true);
      }
      const byId = new Map(exp.map((e) => [e.id, e]));
      let wrong = 0;
      for (const m of list) {
        const e = byId.get(m.id)!;
        if (!e || m.status !== e.status || m.hasPass !== e.hasPass || m.address !== e.address || !m.phone) wrong++;
        if (m.passName === "타센터권") wrong++;
      }
      expect(wrong).toBe(0);
      expect(list.every((m) => !m.name.startsWith("타센터"))).toBe(true);
      // 요청 제약
      expect(state.log.every((l) => !l.error)).toBe(true);
      expect(state.log.every((l) => l.rows <= MAX_ROWS_DEFAULT)).toBe(true);
      expect(Math.max(...state.log.map((l) => l.urlLen))).toBeLessThanOrEqual(URL_LIMIT);
      expect(state.maxInFlight).toBeLessThanOrEqual(6 + 6 * 3);   // 청크 6 x 페이지 3 상한
      // 요청 수 상한 (CODE-INFERRED 공식과 fixture 일치): center_members 페이지 + 청크별(RPC 1 + memberships 페이지)
      const chunks = Math.ceil(n / 150);
      const cmPages = Math.ceil(n / 1000);
      const msCalls = state.log.filter((l) => l.table === "memberships").length;
      expect(state.log.filter((l) => l.table === "center_members").length).toBe(cmPages);
      expect(state.log.filter((l) => l.kind === "rpc").length).toBe(chunks);
      expect(msCalls).toBeGreaterThanOrEqual(chunks);
      expect(state.log.filter((l) => l.table === "profiles").length).toBe(0);
      console.log(`[MEASURED-LOCAL] n=${n} requests=${state.log.length} (center_members=${cmPages}, phoneRpc=${chunks}, memberships=${msCalls}) maxInFlight=${state.maxInFlight}`);
    }, 60_000);
  }

  it("상태 필터(active/expired/dormant)와 수강권 없음 제외 규칙이 5,000명에서도 오라클과 일치", async () => {
    const exp = seed(5000);
    for (const status of ["active", "expired", "dormant"] as const) {
      const got = await fetchMembers("c1", { status });
      const want = exp.filter((e) => e.status === status && (status === "dormant" || e.hasPass)).map((e) => e.id).sort();
      expect(got.map((m) => m.id).sort()).toEqual(want);
    }
  }, 60_000);

  it("서버 max-rows가 1000보다 작아도(예: 500) 누락 없이 전부 가져온다", async () => {
    seed(2300);
    state.maxRows = 500;
    const list = await fetchMembers("c1");
    expect(list.length).toBe(2300);
    expect(new Set(list.map((m) => m.id)).size).toBe(2300);
  }, 60_000);

  it("전화번호 권한이 없으면 모든 회원의 phone이 null (RPC 경유, 직접 select 없음)", async () => {
    seed(1200);
    state.canPhone = false;
    const list = await fetchMembers("c1");
    expect(list.length).toBe(1200);
    expect(list.every((m) => m.phone === null)).toBe(true);
  });

  it("이름/전화/주소 키워드 필터는 전체 목록(1,001명 이상)을 대상으로 한다", async () => {
    seed(2500);
    expect((await fetchMembers("c1", { keyword: "회원2499" })).map((m) => m.name)).toEqual(["회원2499"]);
    expect((await fetchMembers("c1", { keyword: "주소2400", searchField: "address" })).length).toBe(1);
    expect((await fetchMembers("c1", { keyword: "0000-0002", searchField: "phone" })).length).toBeGreaterThan(0);
  });

  it("수강권 조회 실패를 '수강권 없음/전원 만료'로 오인하지 않고 오류로 던진다", async () => {
    seed(300);
    state.membershipError = "boom";
    await expect(fetchMembers("c1")).rejects.toThrow("수강권을 불러오지 못했어요");
  });

  it("페이지 사이에서 행이 밀려 count보다 적게 모이면 부분 결과를 정상으로 보여주지 않고 오류", async () => {
    seed(2500);
    state.dropLastOfPageTwo = true;
    await expect(fetchMembers("c1")).rejects.toThrow("다시 시도");
  });
});
