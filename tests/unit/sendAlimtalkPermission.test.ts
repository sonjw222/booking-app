import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { authorizeAlimtalkCaller, handleImmediateSend, ALIMTALK_PERMISSION, type AuthzDeps, type ImmediateSendDeps } from "../../supabase/functions/_shared/alimtalkAuthz";

/* send-alimtalk 호출자 권한(관리자 QA #239). 판정·즉시 발송 경로는 순수 모듈이라 기본 CI(vitest)에서 직접 실행된다.
   핵심: 권한이 없거나 권한 조회가 실패하면 외부 발송 제공자(send)는 한 번도 호출되지 않는다. */
const SERVICE = "service-role-key"; const CENTER = "center-1"; const BODY = { to: "01000000000", content: "x", centerId: CENTER };
function deps(over: Partial<AuthzDeps & { addon: boolean }> = {}) {
  const calls = { send: vi.fn(async () => ({ status: "sent" as const })), hasPermission: vi.fn(async () => true as boolean | null) };
  const authz: AuthzDeps = {
    serviceRoleKey: SERVICE,
    getUserId: async (h) => (h.includes("valid") ? "user-1" : null),
    resolveAccount: async () => ({ id: "acc-1", is_platform_admin: false }),
    isActiveManager: async () => true,
    hasPermission: async (...a) => { const r = over.hasPermission ? await over.hasPermission(...a) : await calls.hasPermission(); return r; },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "addon" && k !== "hasPermission")),
  };
  const full: ImmediateSendDeps = { authz, isAddonEnabled: async () => over.addon ?? true, send: calls.send };
  return { full, authz, calls };
}
const H = "Bearer valid-token";

describe("authorizeAlimtalkCaller — 판정 규칙", () => {
  it("헤더 없음·무효 JWT 는 401(권한 차단 403 과 구분)", async () => {
    const { authz } = deps();
    expect(await authorizeAlimtalkCaller(authz, null, CENTER)).toMatchObject({ ok: false, status: 401 });
    expect(await authorizeAlimtalkCaller(authz, "Bearer expired", CENTER)).toMatchObject({ ok: false, status: 401 });
  });
  it("유효한 JWT + 센터 활성 매니저이지만 알림톡 권한 없음 → 정확히 403", async () => {
    const { authz } = deps({ hasPermission: async () => false });
    expect(await authorizeAlimtalkCaller(authz, H, CENTER)).toMatchObject({ ok: false, status: 403 });
  });
  it("센터 소속 아님·계정 없음 → 403", async () => {
    expect(await authorizeAlimtalkCaller(deps({ isActiveManager: async () => false }).authz, H, CENTER)).toMatchObject({ ok: false, status: 403 });
    expect(await authorizeAlimtalkCaller(deps({ resolveAccount: async () => null }).authz, H, CENTER)).toMatchObject({ ok: false, status: 403 });
    expect(await authorizeAlimtalkCaller(deps().authz, H, "")).toMatchObject({ ok: false, status: 403 });   // centerId 없는 요청은 사용자 JWT 로는 통과 불가
  });
  it("권한 조회 오류(null·예외)는 fail-closed 500", async () => {
    expect(await authorizeAlimtalkCaller(deps({ hasPermission: async () => null }).authz, H, CENTER)).toMatchObject({ ok: false, status: 500 });
    expect(await authorizeAlimtalkCaller(deps({ hasPermission: async () => { throw new Error("rpc down"); } }).authz, H, CENTER)).toMatchObject({ ok: false, status: 500 });
  });
  it("정상 권한 계정·플랫폼 운영자·service_role 은 통과(권한 키는 message.alimtalk.view)", async () => {
    const d = deps(); const hp = vi.fn(async () => true as boolean | null);
    expect(await authorizeAlimtalkCaller({ ...d.authz, hasPermission: hp }, H, CENTER)).toEqual({ ok: true, via: "permission" });
    expect(hp).toHaveBeenCalledWith(H, CENTER, ALIMTALK_PERMISSION); expect(ALIMTALK_PERMISSION).toBe("message.alimtalk.view");
    expect(await authorizeAlimtalkCaller(deps({ resolveAccount: async () => ({ id: "a", is_platform_admin: true }), hasPermission: async () => false }).authz, H, CENTER)).toEqual({ ok: true, via: "platform_admin" });
    expect(await authorizeAlimtalkCaller(d.authz, `Bearer ${SERVICE}`, CENTER)).toEqual({ ok: true, via: "service_role" });
  });
});

describe("handleImmediateSend — 외부 발송 제공자 호출 횟수", () => {
  it("권한 없음(403)·인증 실패(401)·권한 조회 오류(500)·센터 비소속(403)에서는 발송 제공자 호출 0건", async () => {
    for (const [label, over, authH, status] of [
      ["권한 없음", { hasPermission: async () => false }, H, 403],
      ["JWT 무효", {}, "Bearer expired", 401],
      ["헤더 없음", {}, null, 401],
      ["조회 오류", { hasPermission: async () => null }, H, 500],
      ["센터 비소속", { isActiveManager: async () => false }, H, 403],
    ] as const) {
      const d = deps(over); const r = await handleImmediateSend(d.full, BODY, authH);
      expect(r.status, label).toBe(status); expect(d.calls.send, `${label}: 발송 제공자 호출`).toHaveBeenCalledTimes(0);
    }
  });
  it("애드온 미신청(402)에서도 발송 제공자 호출 0건", async () => {
    const d = deps({ addon: false }); const r = await handleImmediateSend(d.full, BODY, H);
    expect(r.status).toBe(402); expect(d.calls.send).toHaveBeenCalledTimes(0);
  });
  it("정상 권한 계정·service_role 은 발송 제공자를 정확히 1회 호출하고 200", async () => {
    for (const h of [H, `Bearer ${SERVICE}`]) { const d = deps(); const r = await handleImmediateSend(d.full, BODY, h); expect(r.status).toBe(200); expect(d.calls.send).toHaveBeenCalledTimes(1); }
  });
  it("필수 값 누락은 400 이고 권한 조회도 하지 않는다", async () => {
    const d = deps(); const r = await handleImmediateSend(d.full, { to: "x" }, H);
    expect(r.status).toBe(400); expect(d.calls.send).toHaveBeenCalledTimes(0);
  });
});

describe("구조 고정(회귀 방지)", () => {
  const read = (f: string) => readFileSync(path.resolve(__dirname, "../..", f), "utf8");
  const fn = read("supabase/functions/send-alimtalk/index.ts");
  it("send-alimtalk 은 권한 판정·즉시 발송을 공유 모듈로 위임하고, 옛 '센터 소속만 확인' 설명이 남아 있지 않다", () => {
    expect(fn).toContain("authorizeAlimtalkCaller"); expect(fn).toContain("handleImmediateSend");
    expect(fn).not.toMatch(/센터소속 여부만 확인/); expect(fn).not.toContain("isAuthorizedCaller(");
    expect(fn).toMatch(/message\.alimtalk\.view/);
  });
  it("실제 연결: has_permission RPC 를 호출자 JWT 로 호출하고 오류는 null(fail-closed)", () => {
    expect(fn).toMatch(/rpc\("has_permission", \{ p_center_id: centerId, p_permission: permissionKey \}\)/);
    expect(fn).toMatch(/return error \? null : data === true;/);
  });
  it("화면 진입점(회원 목록·발송 화면)도 같은 권한 키로 막는다", () => {
    expect(read("app/manager/members/page.tsx")).toMatch(/canSendAlimtalk = canDo\("message\.alimtalk\.view"\)/);
    expect(read("app/manager/alimtalk/send/page.tsx")).toContain('"message.alimtalk.view"');
  });
});
