import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyMembershipDisplay } from "../../lib/mypage";
import { todayKstYmd } from "../../lib/membershipExpiry";

// 클라이언트 "오늘" 판정은 KST 날짜여야 한다 — new Date().toISOString().slice(0,10)은 UTC 날짜라 KST 00:00~08:59에 어제가 되어
// 어제 만료된 수강권이 아직 유효로, 오늘 시작하는 수강권이 시작 전으로 보였다(서버 RPC는 이미 KST). 2026-10-07.
afterEach(() => vi.useRealTimers());
describe("KST 오늘 날짜(클라이언트 판정)", () => {
  it("todayKstYmd는 UTC 15:00 이후(= KST 다음 날 00:00 이후)에 다음 날짜를 돌려준다", () => {
    expect(todayKstYmd(new Date("2026-10-06T14:59:59Z"))).toBe("2026-10-06");
    expect(todayKstYmd(new Date("2026-10-06T15:00:00Z"))).toBe("2026-10-07");
  });
  it("classifyMembershipDisplay 기본 today: KST 새벽(UTC로는 전날)에도 어제 만료는 만료, 오늘 시작은 시작 전이 아님", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-06T16:30:00Z"));   // KST 2026-10-07 01:30
    const base = { unlimited: false, remainingCount: 5, status: "active" } as never;
    expect(classifyMembershipDisplay({ ...(base as object), expiresAt: "2026-10-06", startsAt: null } as never).isExpired).toBe(true);    // 어제 만료
    expect(classifyMembershipDisplay({ ...(base as object), expiresAt: "2026-10-07", startsAt: null } as never).isExpired).toBe(false);   // 오늘 만료 = 아직 유효
    expect(classifyMembershipDisplay({ ...(base as object), expiresAt: null, startsAt: "2026-10-07" } as never).isPending).toBe(false);   // 오늘 시작 = 시작됨
    expect(classifyMembershipDisplay({ ...(base as object), expiresAt: null, startsAt: "2026-10-08" } as never).isPending).toBe(true);
  });
  it("오늘 비교에 쓰던 UTC 날짜 표현이 해당 파일들에 남아 있지 않다(정적)", () => {
    const root = path.resolve(__dirname, "../..");
    for (const f of ["app/mypage/page.tsx", "lib/reservations.ts", "lib/mypage.ts", "lib/navState.ts", "lib/center.ts", "lib/classes.ts", "lib/home.ts"]) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(src, f).not.toContain("new Date().toISOString().slice(0, 10)");
      expect(src, f).toContain("todayKstYmd");
    }
  });
});
