/*
  성능 배치(2026-10-02) 1: 전체 리로드/시작 작업 축소 — 계약 테스트.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

describe("내부 이동은 Link(prefetch 끔), 보호 대상은 full navigation 유지", () => {
  it("회원 BottomNav의 탭 Link(replace)는 그대로", () => {
    const b = read("app/components/BottomNav.tsx");
    for (const h of ['href="/"', 'href="/search"', 'href="/reservation"', 'href="/mypage"']) expect(b).toMatch(new RegExp(`<Link[^>]*${h.replace(/\//g, "\\/")}[^>]* replace`));
  });
  it("ManagerNav 하위 메뉴는 <a> 없이 Link prefetch={false}(사이드바 링크 20개의 자동 prefetch 폭증 방지), 탭 Link는 replace 유지", () => {
    const m = read("app/components/ManagerNav.tsx");
    expect(m).not.toMatch(/<a [^>]*href="\/manager\/(sales|leads|alimtalk|orders|coupons|announcements|inquiries|reviews|membership-rules|goods|staff|center-info|rooms|settings|subscription|settlement)"/);
    expect(m).toMatch(/<Link[^>]*href="\/manager\/sales" prefetch=\{false\}/);
    expect(m).toMatch(/<Link[^>]*href="\/manager\/classes" replace/);
  });
  it("관리자 홈의 /manager/* 카드 링크가 Link로 바뀌었다", () => {
    const p = read("app/manager/page.tsx");
    expect((p.match(/<Link /g) ?? []).length).toBeGreaterThan(20);
    expect(p).not.toMatch(/<a [^>]*href="\/manager\//);
  });
  it("결제/로그인/OAuth/세션 리셋/Universal Link 코드는 변환하지 않았다(full navigation 유지)", () => {
    for (const f of ["app/checkout/page.tsx", "app/checkout/success/page.tsx", "app/checkout/fail/page.tsx", "app/login/page.tsx", "app/components/SessionWatcher.tsx"]) {
      expect(read(f)).not.toMatch(/prefetch=\{false\}/);
    }
    expect(read("app/login/page.tsx")).toMatch(/window\.location\.href/);
    expect(read("app/login/kakao-callback/page.tsx")).toMatch(/window\.location/);
    expect(read("app/login/naver-callback/page.tsx")).toMatch(/window\.location/);
    expect(read("app/components/CapacitorBootstrap.tsx")).toContain("window.location.replace(target)");
  });
  it("모드 전환(회원↔관리자)·onClick 이동 로직은 그대로 <a>+replaceTabNavigation", () => {
    expect(read("app/components/ManagerNav.tsx")).toContain('onClick={(e) => replaceTabNavigation(e, "/")}');
  });
  it("Universal Link / 카카오·토스페이 비노출 / return-token 경로 보존", () => {
    expect(read("lib/paymentUniversalLink.ts")).toContain("resolvePaymentCallbackTarget");
    expect(read("lib/payMethods.ts")).toContain('HIDDEN_PAY_METHOD_IDS: readonly string[] = ["kakao", "toss"]');
    expect(read("app/api/payments/return/confirm/route.ts")).toContain("confirmForAuthorizedUid");
  });
});

describe("ManagerNav 권한 재조회 축소(보안 경계 변화 없음)", () => {
  const m = read("app/components/ManagerNav.tsx");
  it("pathname마다가 아니라 60초 TTL, 앱 복귀(visibilitychange) 때 재확인", () => {
    expect(m).toContain("const NAV_PERM_RECHECK_MS = 60_000;");
    expect(m).toContain("Date.now() - lastCheckRef.current < NAV_PERM_RECHECK_MS");
    // 이동(pathname)과 앱/탭 복귀(visible)가 같은 recheckPermissions를 직접 호출한다(TTL 안이면 건너뜀, 조회 중이면 중복 방지)
    expect(m).toContain("useEffect(() => { recheckPermissions(); }, [pathname, recheckPermissions]);");
    expect(m).toContain('if (document.visibilityState === "visible") recheckPermissions();');
    expect(m).toContain("if (inFlightRef.current) return;");
    expect(m).not.toContain("lastCheckRef.current = 0; };");   // 예전: 값만 0으로 두고 실제 fetch는 호출하지 않던 handler
    expect(m).toContain("fetchMyEffectivePermissionKeys(");   // 조회 자체는 유지(RLS가 최종 통제)
  });
});

describe("Toss SDK 온디맨드 로드", () => {
  it("RootLayout은 토스 SDK를 로드하지 않고, checkout/Provider/빌링만 loadTossSdk를 쓴다", () => {
    const layout = read("app/layout.tsx");
    expect(layout).not.toMatch(/tosspayments|next\/script/);
    expect(read("app/checkout/page.tsx")).toContain("void loadTossSdk()");
    expect(read("lib/payments/TossPaymentProvider.ts")).toContain("await loadTossSdk()");
    expect(read("lib/centerSubscription.ts")).toContain('import { loadTossSdk } from "./tossSdk"');
    // TossPaymentProvider 계약(간편결제 처리)은 그대로
    expect(read("lib/payments/TossPaymentProvider.ts")).toContain("easyPay");
  });
  describe("loadTossSdk 동작(재시도 복구)", () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
    // 최소 가짜 DOM: head에 붙은 script 목록을 유지하고 remove()가 실제로 제거한다.
    function stub(win: Record<string, unknown>) {
      const scripts: any[] = [];
      const mk = () => { const el: any = { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { el.attrs[k] = v; }, remove() { const i = scripts.indexOf(el); if (i >= 0) scripts.splice(i, 1); } }; return el; };
      const doc = { querySelector: (sel: string) => scripts.find((x) => sel.includes(x.src)) ?? null, head: { appendChild: (el: any) => { scripts.push(el); } }, createElement: () => mk() };
      vi.stubGlobal("window", win); vi.stubGlobal("document", doc);
      return scripts;
    }
    it("이미 window.TossPayments가 있으면 script를 만들지 않고 즉시 성공", async () => {
      const sc = stub({ TossPayments: () => ({}) });
      const { loadTossSdk } = await import("../../lib/tossSdk");
      await expect(loadTossSdk()).resolves.toBeUndefined();
      expect(sc).toHaveLength(0);
    });
    it("동시 2회 호출 → script 1개, load 성공 시 둘 다 resolve, 성공 후 재호출은 다운로드 없음", async () => {
      const win: Record<string, unknown> = {};
      const sc = stub(win);
      const { loadTossSdk, TOSS_SDK_SRC } = await import("../../lib/tossSdk");
      const a = loadTossSdk(1000), b = loadTossSdk(1000);
      expect(sc).toHaveLength(1);
      expect(sc[0].src).toBe(TOSS_SDK_SRC);
      expect(sc[0].attrs["data-mwhabit-toss-sdk"]).toBe("1");
      win.TossPayments = () => ({});
      sc[0].onload();
      await expect(Promise.all([a, b])).resolves.toBeDefined();
      await loadTossSdk();
      expect(sc).toHaveLength(1);
    });
    it("error → reject + 실패한 script 제거, 이후 재호출은 새 script를 삽입하고 성공할 수 있다", async () => {
      const win: Record<string, unknown> = {};
      const sc = stub(win);
      const { loadTossSdk } = await import("../../lib/tossSdk");
      const p1 = loadTossSdk(1000);
      sc[0].onerror();
      await expect(p1).rejects.toThrow("토스 결제 SDK");
      expect(sc).toHaveLength(0);                       // 실패 script 정리
      const p2 = loadTossSdk(1000);
      expect(sc).toHaveLength(1);                       // 새 script
      win.TossPayments = () => ({});
      sc[0].onload();
      await expect(p2).resolves.toBeUndefined();
    });
    it("timeout → reject + script 정리, 이후 재호출 가능", async () => {
      vi.useFakeTimers();
      const win: Record<string, unknown> = {};
      const sc = stub(win);
      const { loadTossSdk } = await import("../../lib/tossSdk");
      const p1 = loadTossSdk(50);
      const assertion = expect(p1).rejects.toThrow("토스 결제 SDK");
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(sc).toHaveLength(0);
      const p2 = loadTossSdk(50);
      expect(sc).toHaveLength(1);
      win.TossPayments = () => ({});
      sc[0].onload();
      await expect(p2).resolves.toBeUndefined();
    });
  });
});

describe("ManagerNav recheck 정책 모델(함수와 동일한 분기)", () => {
  // recheckPermissions의 분기를 그대로 옮긴 모델: inFlight → TTL → fetch(+실패 시 TTL 초기화)
  function make(now: () => number) {
    const st = { last: 0, inFlight: false, fetches: 0 };
    const recheck = () => { if (st.inFlight) return false; if (st.last && now() - st.last < 60_000) return false; st.inFlight = true; st.last = now(); st.fetches++; return true; };
    return { st, recheck, done: () => { st.inFlight = false; } };
  }
  it("visible + stale → 재조회, TTL 미만 → 재조회 안 함, pathname 이동 + stale → 재조회, 조회 중 중복 호출 → 무시", () => {
    let t = 1_000_000;
    const m = make(() => t);
    expect(m.recheck()).toBe(true);          // 최초
    expect(m.recheck()).toBe(false);         // 조회 중
    m.done();
    t += 30_000; expect(m.recheck()).toBe(false);   // TTL 미만
    t += 31_000; expect(m.recheck()).toBe(true);    // 60초 경과(visible 또는 pathname)
    expect(m.st.fetches).toBe(2);
  });
  it("메뉴/권한 계약 유지: fetchMyEffectivePermissionKeys → setMyPerms, canSeeManagerMenu 사용", () => {
    const m = read("app/components/ManagerNav.tsx");
    expect(m).toContain("fetchMyEffectivePermissionKeys(active.managerCenterId, active.roleId)");
    expect(m).toContain("setMyPerms(keys)");
    expect(m).toContain("canSeeManagerMenu(isOwner, myPerms, permissionKey)");
  });
});
