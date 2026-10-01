/*
  main merge 전 마지막 blocker 2건(2026-10-01):
  1) 마지막 활성 owner를 UPDATE로 강등하는 경로 차단(manager_centers BEFORE UPDATE 트리거)
  2) 자동결제(billing) OFF에서는 Toss 시크릿 없이도 cron/confirm이 안전해야 함
  DB가 없는 환경이라 SQL은 소스 텍스트 계약 + 규칙을 그대로 옮긴 순수 모델로 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const sql = noComments(read("fix_manager_centers_rls_recursion_final.sql"));

describe("[1] 마지막 활성 owner UPDATE 강등 차단 — 트리거 계약", () => {
  const trig = sql.slice(sql.indexOf("create or replace function manager_centers_protect_last_owner"));
  it("BEFORE UPDATE 행 트리거로 걸려 있고 SECURITY DEFINER + 고정 search_path, 실행 권한 회수", () => {
    expect(trig).toContain("before update on manager_centers");
    expect(trig).toContain("for each row execute function manager_centers_protect_last_owner()");
    expect(trig).toContain("security definer");
    expect(trig).toContain("set search_path = public");
    expect(trig).toContain("revoke all on function manager_centers_protect_last_owner() from public, anon, authenticated;");
  });
  it("OLD가 활성 owner(status='active' + owner 역할)일 때만 개입하고, owner 자격이 유지되는 수정은 통과", () => {
    expect(trig).toContain("old.status = 'active'");
    expect(trig).toContain("role_id_is_owner_for_center(old.role_id, old.center_id)");
    expect(trig).toContain("new.status = 'active'");
    expect(trig).toContain("role_id_is_owner_for_center(new.role_id, new.center_id)");
    expect(trig).toContain("new.center_id = old.center_id");   // 다른 센터로 옮겨 자격을 잃는 경우도 강등으로 취급
  });
  it("센터별로 다른 활성 owner를 확인하고(없으면 예외), 동시 강등 경합은 센터 단위 advisory lock으로 직렬화", () => {
    expect(trig).toContain("mc.center_id = old.center_id and mc.id <> old.id and mc.status = 'active' and r.is_owner");
    expect(trig).toContain("pg_advisory_xact_lock(hashtextextended('manager_centers_owner:' || old.center_id::text, 0))");
    expect(trig).toContain("raise exception '센터의 마지막 활성 오너는 강등하거나 비활성화할 수 없어요");
  });
  it("RLS를 끄지 않는다 + 롤백이 트리거/함수를 제거한다", () => {
    expect(sql).not.toMatch(/disable row level security/i);
    const rb = read("rollback_fix_manager_centers_rls_recursion_final.sql");
    expect(rb).toContain("drop trigger if exists manager_centers_protect_last_owner on manager_centers;");
    expect(rb).toContain("drop function if exists manager_centers_protect_last_owner();");
  });

  // 트리거 + 정책 규칙을 그대로 옮긴 순수 모델(A~F 시나리오)
  type Row = { id: string; center: string; account: string; role: "owner" | "manager" | "instructor" | null; status: "active" | "pending" | "inactive"; name?: string };
  const isActiveOwner = (r: Row) => r.status === "active" && r.role === "owner";
  function update(rows: Row[], id: string, patch: Partial<Row>, actor: { account: string; center: string }) {
    const old = rows.find((r) => r.id === id)!;
    const next = { ...old, ...patch };
    // 정책: 오너 행/owner 역할 변경은 같은 센터의 오너만, 다른 센터 사람은 불가
    const actorIsOwner = rows.some((r) => r.account === actor.account && r.center === old.center && isActiveOwner(r));
    const actorInCenter = actor.center === old.center;
    if (!actorInCenter) throw new Error("rls");
    if ((old.role === "owner" || next.role === "owner") && !actorIsOwner) throw new Error("rls-owner-only");
    // 트리거
    if (isActiveOwner(old) && !(next.center === old.center && isActiveOwner(next))) {
      const others = rows.filter((r) => r.center === old.center && r.id !== old.id && isActiveOwner(r));
      if (others.length === 0) throw new Error("last-owner");
    }
    Object.assign(old, patch);
  }
  const mk = (): Row[] => [
    { id: "o1", center: "A", account: "u1", role: "owner", status: "active" },
    { id: "m1", center: "A", account: "u2", role: "manager", status: "active" },
    { id: "x1", center: "B", account: "u9", role: "manager", status: "active" },
  ];
  it("A. owner 1명: owner → manager 실패(non-owner role들 모두, 비활성화도 실패)", () => {
    for (const role of ["manager", "instructor", null] as const) {
      expect(() => update(mk(), "o1", { role }, { account: "u1", center: "A" })).toThrow("last-owner");
    }
    expect(() => update(mk(), "o1", { status: "inactive" }, { account: "u1", center: "A" })).toThrow("last-owner");
    expect(() => update(mk(), "o1", { status: "pending" }, { account: "u1", center: "A" })).toThrow("last-owner");
  });
  it("B. owner 2명: owner1 → manager 성공(센터별 격리: 다른 센터 owner는 세지 않음)", () => {
    const rows = mk(); rows.push({ id: "o2", center: "A", account: "u3", role: "owner", status: "active" });
    update(rows, "o1", { role: "manager" }, { account: "u1", center: "A" });
    expect(rows.find((r) => r.id === "o1")!.role).toBe("manager");
    const iso = mk(); iso.push({ id: "oB", center: "B", account: "u8", role: "owner", status: "active" });
    expect(() => update(iso, "o1", { role: "manager" }, { account: "u1", center: "A" })).toThrow("last-owner");
  });
  it("C. 마지막 owner DELETE는 기존 정책으로 계속 차단", () => {
    expect(sql).toContain("and not manager_centers_is_last_active_owner(center_id, id)");
  });
  it("D. 일반 manager가 owner 권한을 바꾸려 하면 실패", () => {
    expect(() => update(mk(), "m1", { role: "owner" }, { account: "u2", center: "A" })).toThrow("rls-owner-only");
    expect(() => update(mk(), "o1", { role: "manager" }, { account: "u2", center: "A" })).toThrow("rls-owner-only");
  });
  it("E. 다른 센터 manager는 변경할 수 없다", () => {
    expect(() => update(mk(), "o1", { role: "manager" }, { account: "u9", center: "B" })).toThrow("rls");
  });
  it("F. owner 자격과 무관한 필드(이름 등) 수정은 마지막 owner여도 정상", () => {
    const rows = mk();
    update(rows, "o1", { name: "새 이름" }, { account: "u1", center: "A" });
    expect(rows[0].name).toBe("새 이름");
    expect(rows[0].role).toBe("owner");
  });
});

describe("[2] Billing OFF — Toss 시크릿 없이 안전", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.doUnmock("@supabase/supabase-js"); });

  const cronReq = () => new Request("http://localhost/api/billing/charge-due", { method: "POST", headers: { "x-cron-secret": "unit-test-placeholder-cron-secret" } });
  const confirmReq = () => new Request("http://localhost/api/billing/confirm", { method: "POST", body: JSON.stringify({ authKey: "a", customerKey: "center-c1", centerId: "c1" }) });
  function trackDb(reviewOverride: boolean) {
    const calls = { createClient: 0, from: [] as string[] };
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => {
        calls.createClient++;
        const chain: any = {
          select: () => chain, eq: () => chain, update: () => chain, in: () => chain, lte: () => chain, or: () => chain,
          maybeSingle: async () => ({ data: { billing_review_override: reviewOverride }, error: null }),
        };
        return { from: (t: string) => { calls.from.push(t); return chain; } };
      },
    }));
    return calls;
  }

  it("flag false + billing secret 없음 → charge-due는 500이 아니라 200 skipped, DB/Toss 접근 없음", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "false");
    vi.stubEnv("TOSS_BILLING_SECRET_KEY", "");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const calls = trackDb(false);
    const { POST } = await import("../../app/api/billing/charge-due/route");
    const res = await POST(cronReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "billing_disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.createClient).toBe(0);   // 선점/청구/retry_count/payment_failed 처리 전부 없음
  });
  it("flag 미설정(undefined)도 OFF로 취급", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "");
    vi.stubEnv("TOSS_BILLING_SECRET_KEY", "");
    const calls = trackDb(false);
    const { POST } = await import("../../app/api/billing/charge-due/route");
    expect((await POST(cronReq())).status).toBe(200);
    expect(calls.createClient).toBe(0);
  });
  it("flag false여도 cron 인증은 여전히 먼저다(잘못된 secret은 401)", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "false");
    const { POST } = await import("../../app/api/billing/charge-due/route");
    expect((await POST(new Request("http://localhost/api/billing/charge-due", { method: "POST" }))).status).toBe(401);
  });
  it("flag true + secret 없음 → 명확한 서버 설정 오류(500)", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "true");
    vi.stubEnv("TOSS_BILLING_SECRET_KEY", "");
    const { POST } = await import("../../app/api/billing/charge-due/route");
    const res = await POST(cronReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("TOSS_BILLING_SECRET_KEY");
  });
  it("flag true + secret 있음 → 기존 흐름 유지(대상 조회까지 진행)", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "true");
    const calls = trackDb(false);
    const { POST } = await import("../../app/api/billing/charge-due/route");
    const res = await POST(cronReq());
    expect(res.status).not.toBe(401);
    expect(calls.from).toContain("center_subscriptions");
  });

  it("confirm: flag false → Toss 호출 없이 403(키 없어도), 시크릿 확인보다 먼저", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "false");
    vi.stubEnv("TOSS_BILLING_SECRET_KEY", "");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    trackDb(false);
    const { POST } = await import("../../app/api/billing/confirm/route");
    const res = await POST(confirmReq());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("billing_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("confirm: flag false라도 운영자가 지정한 토스 심사 센터만 예외(그 외 센터는 403)", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "false");
    vi.stubEnv("TOSS_BILLING_SECRET_KEY", "");
    trackDb(true);
    const { POST } = await import("../../app/api/billing/confirm/route");
    const res = await POST(confirmReq());
    expect(res.status).toBe(500);   // 게이트는 통과, 심사 센터인데 키가 없으면 명확한 설정 오류
    expect((await res.json()).error).toContain("TOSS_BILLING_SECRET_KEY");
  });
  it("confirm: flag true + secret 없음 → 서버 설정 오류", async () => {
    vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "true");
    vi.stubEnv("TOSS_BILLING_SECRET_KEY", "");
    const { POST } = await import("../../app/api/billing/confirm/route");
    const res = await POST(confirmReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("TOSS_BILLING_SECRET_KEY");
  });

  it("TOSS_SECRET_KEY(회원 결제)와 TOSS_BILLING_SECRET_KEY 분리 회귀 없음", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const p of ["app/api/billing/confirm/route.ts", "app/api/billing/charge-due/route.ts"]) {
      expect(strip(read(p))).not.toContain("process.env.TOSS_SECRET_KEY");
    }
    expect(read("app/api/payments/confirm/route.ts")).not.toContain("TOSS_BILLING_SECRET_KEY");
  });
});
