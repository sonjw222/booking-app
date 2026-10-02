/* 코드 리뷰 보완(2026-10-03): 소셜 이름 gate / 일괄 예약조건 preflight / bulk 시트 수업 목록 / 진도 SQL 동시성 / 센터 공유 위치 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

// ---- 가짜 supabase: update 호출을 기록하고 테이블별 영향 행/오류를 주입한다
type Upd = { table: string; patch: any; eq: [string, any][] };
const updates: Upd[] = [];
let failTable: string | null = null;
let zeroRowsTable: string | null = null;
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (table: string) => {
      const rec: Upd = { table, patch: null, eq: [] };
      const chain: any = {
        update(patch: any) { rec.patch = patch; updates.push(rec); return chain; },
        eq(c: string, v: any) { rec.eq.push([c, v]); return chain; },
        select() { return chain; },
        then(res: any) {
          if (failTable === table) return Promise.resolve({ data: null, error: { message: "boom", code: "XX" } }).then(res);
          return Promise.resolve({ data: zeroRowsTable === table ? [] : [{ id: "row" }], error: null }).then(res);
        },
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  },
}));
import { completeSocialName, completeSocialProfile } from "../../lib/authAccount";
import { socialCompletionNeed } from "../../lib/memberName";
import { applyRulesToProducts, bulkRuleSummary, preflightBulkRules } from "../../lib/ruleBulk";

beforeEach(() => { updates.length = 0; failTable = null; zeroRowsTable = null; });

describe("[1] 소셜 가입 마무리 gate", () => {
  const A = (o: Partial<{ isSocial: boolean; phone: string | null; name: string | null; profileName: string | null }>) => ({ isSocial: true, phone: "01012345678", name: "홍길동", profileName: "홍길동", ...o });
  it("신규 social + phone 없음 + name 없음 → full", () => expect(socialCompletionNeed(A({ phone: null, name: null, profileName: null }))).toBe("full"));
  it("기존 social + phone 있음 + synthetic name → name(이름만)", () => {
    expect(socialCompletionNeed(A({ name: "92wr87mcz5", profileName: "92wr87mcz5" }))).toBe("name");
    expect(socialCompletionNeed(A({ name: "홍길동", profileName: "92wr87mcz5" }))).toBe("name");   // 대표 프로필이 합성이면 관리자에겐 미등록
    expect(socialCompletionNeed(A({ name: "92wr87mcz5", profileName: "홍길동" }))).toBe("name");
  });
  it("기존 social + phone 있음 + 정상 name → gate 없음", () => expect(socialCompletionNeed(A({}))).toBeNull());
  it("기존 social + phone 없음 + 정상 name → full(기존 phone completion)", () => expect(socialCompletionNeed(A({ phone: null }))).toBe("full"));
  it("email 계정은 어떤 경우에도 gate 없음", () => {
    expect(socialCompletionNeed(A({ isSocial: false, phone: null, name: "92wr87mcz5" }))).toBeNull();
    expect(socialCompletionNeed(null)).toBeNull();
  });
  it("name-only 저장은 대표 프로필 → accounts 순서로 이름만 갱신하고 phone/address/동의는 건드리지 않는다", async () => {
    await completeSocialName("acc1", "홍길동");
    expect(updates.map((u) => [u.table, u.patch])).toEqual([["profiles", { name: "홍길동" }], ["accounts", { name: "홍길동" }]]);
    expect(updates[0].eq).toEqual([["account_id", "acc1"], ["is_primary", true]]);
    for (const u of updates) expect(Object.keys(u.patch)).toEqual(["name"]);
  });
  it("저장 실패(오류/0행)는 성공 처리하지 않는다 — gate가 다시 나타나도록 throw", async () => {
    failTable = "profiles";
    await expect(completeSocialName("acc1", "홍길동")).rejects.toThrow("이름을 저장하지 못했어요");
    expect(updates.map((u) => u.table)).toEqual(["profiles"]);   // 프로필 실패 시 accounts는 건드리지 않음
    updates.length = 0; failTable = null; zeroRowsTable = "accounts";
    await expect(completeSocialName("acc1", "홍길동")).rejects.toThrow("계정 갱신 실패");
    updates.length = 0; zeroRowsTable = "profiles";
    await expect(completeSocialName("acc1", "홍길동")).rejects.toThrow("대표 프로필 없음");
    await expect(completeSocialName("acc1", "  ")).rejects.toThrow("이름을 입력해주세요");
  });
  it("full 흐름: 이름(프로필→accounts) 저장 후 phone/address/동의 저장", async () => {
    await completeSocialProfile("acc1", "01099998888", null, false, "홍길동");
    expect(updates.map((u) => u.table)).toEqual(["profiles", "accounts", "accounts"]);
    expect(updates[2].patch).toMatchObject({ phone: "01099998888", marketing_consent: false });
    expect(updates[2].patch).not.toHaveProperty("name");
  });
  it("SessionWatcher: need별 gate 분기 + 합성 입력 거부, 사용자 이름 추측 없음", () => {
    const w = read("app/components/SessionWatcher.tsx");
    expect(w).toContain("const need = socialCompletionNeed(account);");
    expect(w).toContain('setPhoneGateAccountId(account && need === "full" ? account.id : null);');
    expect(w).toContain('setNameGateAccountId(account && need === "name" ? account.id : null);');
    expect(w).toContain("await completeSocialName(nameGateAccountId, realName.trim());");
    expect(w).toContain("실제 이름을 입력해주세요");
    expect(read("lib/authAccount.ts")).toContain('.is("deleted_at", null).limit(1);');
  });
});

describe("[2] 일괄 예약조건 — 부분 요일 적용 금지", () => {
  const T = (id: string, autoBookDays: number[] | null = null, existingRules: any[] = []) => ({ id, name: `수강권${id}`, autoBookDays, existingRules });
  it("월+수 요청 / 월 고정 → write 0, 명시적 incompatible", async () => {
    const add = vi.fn(async () => {});
    const r = await applyRulesToProducts([T("a", [1])], { days: [1, 3], startTime: null, classTitle: null }, add);
    expect(add).not.toHaveBeenCalled();
    expect(r.incompatible).toEqual([{ id: "a", name: "수강권a", reason: "locked_days", lockedDays: [1] }]);
    expect(r.succeeded).toEqual([]);
    const s = bulkRuleSummary(r);
    expect(s.hasFailure).toBe(true);
    expect(s.message).toContain("아무것도 적용하지 않았어요");
    expect(s.message).toContain("수강권a(고정 월)");
  });
  it("월 요청 / 월 고정 → 정상", async () => {
    const add = vi.fn(async () => {});
    const r = await applyRulesToProducts([T("a", [1])], { days: [1], startTime: "19:00", classTitle: null }, add);
    expect(r.succeeded).toEqual([{ id: "a", name: "수강권a", added: 1 }]);
    expect(add).toHaveBeenCalledWith("a", 1, "19:00", null);
  });
  it("월 요청 / 월 rule 이미 존재 → 중복 없이 정상 final state", async () => {
    const add = vi.fn(async () => {});
    const r = await applyRulesToProducts([T("a", [1], [{ dayOfWeek: 1, startTime: null, classTitle: null }])], { days: [1], startTime: null, classTitle: null }, add);
    expect(add).not.toHaveBeenCalled();
    expect(r.skipped).toEqual([{ id: "a", name: "수강권a", reason: "already_exists" }]);
    expect(bulkRuleSummary(r).hasFailure).toBe(false);
  });
  it("mixed target 중 하나만 비호환이어도 DB write 시작 전에 전체 차단", async () => {
    const add = vi.fn(async () => {});
    const r = await applyRulesToProducts([T("free"), T("ok", [1, 3]), T("bad", [2])], { days: [1, 3], startTime: null, classTitle: null }, add);
    expect(add).not.toHaveBeenCalled();
    expect(r.incompatible.map((x) => x.id)).toEqual(["bad"]);
    expect(r.succeeded).toEqual([]);
  });
  it("'모든 요일'(null) 요청은 요일 고정 수강권과 비호환, 고정 없는 수강권은 호환", () => {
    expect(preflightBulkRules([T("a", [1])], { days: [null] })).toHaveLength(1);
    expect(preflightBulkRules([T("a")], { days: [null] })).toEqual([]);
    expect(preflightBulkRules([T("a", [])], { days: [1, 2] })).toEqual([]);
  });
  it("write 중 네트워크/RLS 부분 실패는 숨기지 않는다", async () => {
    const add = vi.fn(async (id: string) => { if (id === "b") throw new Error("RLS"); });
    const r = await applyRulesToProducts([T("a"), T("b")], { days: [1], startTime: null, classTitle: null }, add);
    expect(r.succeeded.map((x) => x.id)).toEqual(["a"]);
    expect(r.failed).toEqual([{ id: "b", name: "수강권b", error: "RLS" }]);
    expect(bulkRuleSummary(r).hasFailure).toBe(true);
  });
  it("화면: preflight 차단 시 선택/입력 유지(시트 유지), 부분 실패 경로는 기존대로", () => {
    const p = read("app/manager/membership-rules/page.tsx");
    expect(p).toContain("if (result.incompatible.length > 0) {");
    expect(p.indexOf("if (result.incompatible.length > 0) {")).toBeLessThan(p.indexOf("} else if (sum.hasFailure) {"));
    expect(p).toContain("setBulkTargets(bulkTargets.filter((p) => failedIds.has(p.id)));");
  });
});

describe("[3] 일괄 시트도 현재 센터 수업 목록을 새로 읽는다", () => {
  const p = read("app/manager/membership-rules/page.tsx");
  it("openBulkRuleSheet/openRuleSheet 모두 loadClassOptions 호출", () => {
    const bulk = p.slice(p.indexOf("async function openBulkRuleSheet"), p.indexOf("async function handleBulkAddRules"));
    expect(bulk).toContain("await loadClassOptions();");
    const single = p.slice(p.indexOf("async function openRuleSheet"), p.indexOf("async function loadClassOptions"));
    expect(single).toContain("await loadClassOptions();");
  });
  it("race 방어는 lib/classOptionsLoader.ts로 위임(동작은 releaseQaRaceAndAutoName.test.ts), 센터 변경 시 목록 초기화", () => {
    expect(p).toContain("await loadClassOptionsGuarded({");
    expect(p).toContain("useEffect(() => { centerIdRef.current = centerId; setExistingClasses([]); }, [centerId]);");
  });
});

describe("[4][5] 진도 SQL 동시성 / preflight", () => {
  const sql = read("fix_progress_category_tree_20261003.sql").replace(/--.*$/gm, "");
  it("센터별 xact advisory lock이 검증 읽기보다 먼저, session lock/전역 lock 아님", () => {
    const i = sql.indexOf("pg_advisory_xact_lock(hashtextextended('progress_categories_tree:' || new.center_id::text, 0))");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(sql.indexOf("select center_id into v_parent_center"));
    expect(sql).not.toMatch(/pg_advisory_lock\(/);
  });
  it("migration은 transaction + idempotent, rollback은 이 migration의 trigger/function만 제거", () => {
    expect(sql).toMatch(/^\s*begin;/);
    expect(sql).toContain("commit;");
    expect(sql).toContain("create or replace function public.progress_categories_guard_tree()");
    expect(sql).toContain("drop trigger if exists progress_categories_guard_tree");
    expect(sql).not.toMatch(/\b(delete from|update public\.progress_categories|truncate|drop table)\b/i);
    const rb = read("rollback_fix_progress_category_tree_20261003.sql");
    expect(rb.match(/drop /g)).toHaveLength(2);
  });
  it("verify SQL은 read-only이고 순환에 안전(path 배열 + 깊이 상한)", () => {
    const v = read("verify_progress_category_tree_20261003.sql").replace(/--.*$/gm, "");
    expect(v).not.toMatch(/\b(insert|update|delete|drop|alter|truncate)\b/i);
    expect(v).toContain("not (p.id = any(w.path))");
    expect(v).toContain("w.lvl < 64");
  });
});

describe("[7] 센터 상세 공유 버튼 위치", () => {
  it("센터명과 공유가 같은 row(namerow) 안에 있고 공유는 오른쪽 보조 action, handler는 그대로", () => {
    const page = read("app/center/[id]/page.tsx");
    const row = page.slice(page.indexOf('<div className="center-hero-namerow">'), page.indexOf("{center.address &&"));
    expect(row).toContain('className="center-hero-name"');
    expect(row).toContain("center-hero-share");
    expect(row).toContain("onClick={handleShareCenter}");
    const css = read("app/globals.css");
    expect(css).toMatch(/\.center-hero-share \{[^}]*position: absolute; right: 0/);
    expect(css).toMatch(/\.center-hero-namerow \{[^}]*padding: 0 60px/);
  });
});
