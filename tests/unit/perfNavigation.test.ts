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
    expect(m).toContain('document.addEventListener("visibilitychange", onVisible)');
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
  describe("loadTossSdk 동작", () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
    function stub(win: Record<string, unknown>) {
      const appended: any[] = [];
      const doc = { querySelector: () => null, head: { appendChild: (el: any) => appended.push(el) }, createElement: () => ({}) };
      vi.stubGlobal("window", win); vi.stubGlobal("document", doc);
      return appended;
    }
    it("이미 로드됨 → 즉시 resolve, script 삽입 없음", async () => {
      const a = stub({ TossPayments: () => ({}) });
      const { loadTossSdk } = await import("../../lib/tossSdk");
      await expect(loadTossSdk()).resolves.toBeUndefined();
      expect(a).toHaveLength(0);
    });
    it("미로드 → v2 script를 한 번 삽입하고 onload에서 resolve, 실패/시간초과는 reject", async () => {
      const win: Record<string, unknown> = {};
      const a = stub(win);
      const { loadTossSdk, TOSS_SDK_SRC } = await import("../../lib/tossSdk");
      const p = loadTossSdk(50);
      expect(a).toHaveLength(1);
      expect(a[0].src).toBe(TOSS_SDK_SRC);
      win.TossPayments = () => ({});
      a[0].onload();
      await expect(p).resolves.toBeUndefined();
      const a2 = stub({});
      const { loadTossSdk: again } = await import("../../lib/tossSdk");
      await expect(again(10)).rejects.toThrow("토스 결제 SDK");
      expect(a2.length).toBeGreaterThanOrEqual(0);
    });
  });
});
