/*
  Batch E 성능(PERF-040~044) — 결과 동일성 단위 테스트. Supabase는 vi.mock 가짜 쿼리 빌더로 대체(네트워크 없음).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table?: string; rpc?: string; ops: [string, unknown[]][] };
const calls: Call[] = [];
let handler: (c: Call) => { data: unknown; error: unknown };

function builder(c: Call) {
  const b: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => void) => res(handler(c));
      return (...args: unknown[]) => { c.ops.push([prop, args]); return b; };
    },
  });
  return b;
}
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (table: string) => { const c: Call = { table, ops: [] }; calls.push(c); return builder(c); },
    rpc: (rpc: string, args: unknown) => { const c: Call = { rpc, ops: [["args", [args]]] }; calls.push(c); return builder(c); },
  },
}));

import { fetchRules, fetchRulesMapForProducts } from "../../lib/passes";
import { fetchVisibilityMemberLabels } from "../../lib/visibilityMemberLabels";
import { fetchPayments } from "../../lib/sales";
import { patchTierRow } from "../../lib/tierRows";
import { draftsToTiers, type TierDraft } from "../../lib/selectableCount";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

const RULE_ROWS = [
  { id: "r1", product_id: "pA", day_of_week: 1, start_time: "16:00:00", class_title: null },
  { id: "r2", product_id: "pB", day_of_week: null, start_time: null, class_title: "필라" },
  { id: "r3", product_id: "pA", day_of_week: 3, start_time: "20:00:00", class_title: "요가" },
];

beforeEach(() => { calls.length = 0; });

describe("PERF-040 규칙 일괄 조회 = 상품별 fetchRules", () => {
  it("상품별 결과가 기존 N회 호출과 정확히 같고(규칙 없는 상품은 []), 요청은 1회", async () => {
    handler = (c) => {
      const eq = c.ops.find(([o]) => o === "eq");
      const inn = c.ops.find(([o]) => o === "in");
      let rows = RULE_ROWS;
      if (eq) rows = rows.filter((r) => r.product_id === (eq[1] as string[])[1]);
      if (inn) rows = rows.filter((r) => (inn[1] as [string, string[]])[1].includes(r.product_id));
      return { data: rows, error: null };
    };
    const ids = ["pA", "pB", "pC"];
    const old: Record<string, unknown> = {};
    for (const id of ids) old[id] = await fetchRules(id);
    expect(calls).toHaveLength(3);
    calls.length = 0;
    const next = await fetchRulesMapForProducts(ids);
    expect(calls).toHaveLength(1);
    expect(next).toEqual(old);
    expect(next.pC).toEqual([]);
    expect(next.pA.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(next.pA[0].startTime).toBe("16:00");
  });
  it("상품이 없으면 요청 없이 {}", async () => {
    expect(await fetchRulesMapForProducts([])).toEqual({});
    expect(calls).toHaveLength(0);
  });
  it("조회 오류는 기존과 같이 throw", async () => {
    handler = () => ({ data: null, error: { message: "boom" } });
    await expect(fetchRulesMapForProducts(["pA"])).rejects.toThrow("예약조건을 불러오지 못했어요: boom");
  });
});

describe("PERF-043 공개범위 지정 회원 라벨", () => {
  it("선택 id만 center_id 필터로 조회하고 전화는 권한 RPC 결과만 사용(없으면 이름만)", async () => {
    handler = (c) => {
      if (c.rpc) return { data: [{ profile_id: "p1", account_phone: "010-1111-2222" }], error: null };
      return { data: [
        { id: "cm1", profile_id: "p1", profiles: { name: "홍길동" } },
        { id: "cm2", profile_id: "p2", profiles: { name: "김철수" } },   // 전화 마스킹/권한 없음 → RPC 행 없음
      ], error: null };
    };
    const labels = await fetchVisibilityMemberLabels("c1", ["cm1", "cm2"]);
    expect(labels).toEqual({ cm1: "홍길동 010-1111-2222", cm2: "김철수" });
    expect(calls).toHaveLength(2);   // 기존 fetchMembers는 최소 4회(회원/프로필/전화RPC/수강권) + 전체 회원
    const q = calls[0];
    expect(q.ops).toContainEqual(["eq", ["center_id", "c1"]]);
    expect(q.ops).toContainEqual(["in", ["id", ["cm1", "cm2"]]]);
    expect(calls[1].rpc).toBe("fetch_member_phones_safe");
  });
  it("빈 선택은 요청 없음", async () => {
    expect(await fetchVisibilityMemberLabels("c1", [])).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe("PERF-042 fetchPayments 페이징", () => {
  const mk = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({
    id: `pay${offset + i}`, sale_type: "new", card_amount: 1, cash_amount: 0, transfer_amount: 0, point_amount: 0,
    direct_amount: 0, total_amount: 1, unpaid_amount: 0, paid_at: "2026-10-01T00:00:00+09:00", memo: null,
    profiles: { name: "a" }, accounts: null, memberships: null,
  }));
  it("1000건 미만이면 요청 1회, 결과 그대로", async () => {
    handler = () => ({ data: mk(10), error: null });
    const rows = await fetchPayments("c1", "2026-10-01", "2026-10-31");
    expect(calls).toHaveLength(1);
    expect(rows).toHaveLength(10);
  });
  it("2500건이면 3페이지로 전부 모으고 순서를 유지한다", async () => {
    const all = mk(2500);
    handler = (c) => {
      const [from, to] = (c.ops.find(([o]) => o === "range")![1]) as [number, number];
      return { data: all.slice(from, to + 1), error: null };
    };
    const rows = await fetchPayments("c1", "2026-10-01", "2026-10-31");
    expect(calls).toHaveLength(3);
    expect(rows).toHaveLength(2500);
    expect(rows[0].id).toBe("pay0");
    expect(rows[2499].id).toBe("pay2499");
    expect(calls[0].ops.filter(([o]) => o === "order")).toHaveLength(2);   // paid_at + id 보조 정렬
  });
});

describe("PERF-041 CountPriceEditor 행 갱신", () => {
  const rows: TierDraft[] = [
    { count: 1, price: "6000", enabled: true }, { count: 2, price: "", enabled: false }, { count: 3, price: "17000", enabled: true },
  ];
  const legacy = (rs: TierDraft[], count: number, patch: Partial<TierDraft>) =>
    rs.map((r) => (r.count === count ? { ...r, ...patch } : r));
  it("기존 인라인 구현과 결과(저장 직렬화 포함)가 같다", () => {
    for (const [c, p] of [[2, { enabled: true }], [2, { price: "9000" }], [3, { enabled: false }], [9, { price: "1" }]] as const) {
      const a = patchTierRow(rows, c, p);
      expect(a).toEqual(legacy(rows, c, p));
      expect(JSON.stringify(draftsToTiers(a))).toBe(JSON.stringify(draftsToTiers(legacy(rows, c, p))));
    }
  });
  it("바뀌지 않은 행은 같은 참조를 유지한다(memo 전제)", () => {
    const next = patchTierRow(rows, 2, { price: "9000" });
    expect(next[0]).toBe(rows[0]);
    expect(next[2]).toBe(rows[2]);
    expect(next[1]).not.toBe(rows[1]);
  });
  it("편집기는 memo된 행 + 안정 콜백을 쓴다(정적 계약)", () => {
    const src = read("app/components/CountPriceEditor.tsx");
    expect(src).toContain("memo(function TierRow");
    expect(src).toContain("useCallback");
  });
});

describe("정적 계약(화면 배선)", () => {
  it("매출: 기간 변경 load()는 포인트 이력을 다시 받지 않고, 포인트 탭 effect + 변경 시 버전 갱신", () => {
    const src = read("app/manager/sales/page.tsx");
    const loadBody = src.slice(src.indexOf("const load = useCallback"), src.indexOf("useEffect(() => { load(); }, [load]);"));
    expect(loadBody).not.toContain("fetchPoints");
    expect(src).toContain("pointsVersion");
    expect((src.match(/await load\(\);/g) ?? []).length).toBe(1);   // reload() 내부 한 곳뿐, 변경 핸들러는 모두 reload()
  });
  it("membership-rules: N+1 제거 + 공개범위 전체 회원 조회 제거 + 변경 후 배경 갱신", () => {
    const src = read("app/manager/membership-rules/page.tsx");
    expect(src).not.toContain("prods.map(async");
    expect(src).toContain("fetchRulesMapForProducts");
    expect(src).not.toContain("await fetchMembers(centerId);");
    expect(src).toContain("loadedCenterRef");
  });
  it("staff: load가 activeRoleId에 의존하지 않는다(첫 진입 3요청 중복 방지)", () => {
    expect(read("app/manager/staff/page.tsx")).toContain("}, [centerId]);\n\n  useEffect(() => { load(); }, [load]);");
  });
});
