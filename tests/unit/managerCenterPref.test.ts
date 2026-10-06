// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRememberedCenter, pickInitialCenterId, readRememberedCenterId, rememberCenterId, setPrefAccount } from "../../lib/managerCenterPref";

const C = (...ids: string[]) => ids.map((id) => ({ id }));
beforeEach(() => { window.localStorage.clear(); setPrefAccount(null); });

describe("managerCenterPref", () => {
  it("저장값이 없으면 첫 센터(기존 동작), 빈 목록이면 null", () => {
    setPrefAccount("acc1");
    expect(pickInitialCenterId(C("a", "b"))).toBe("a");
    expect(pickInitialCenterId([])).toBeNull();
  });
  it("저장된 센터가 목록에 있으면 복원", () => {
    setPrefAccount("acc1"); rememberCenterId("b");
    expect(pickInitialCenterId(C("a", "b"))).toBe("b");
  });
  it("권한 없는(목록에 없는) 저장 id는 버리고 첫 센터", () => {
    setPrefAccount("acc1"); rememberCenterId("gone");
    expect(pickInitialCenterId(C("a", "b"))).toBe("a");
  });
  it("계정별로 분리: 다른 계정 값은 읽지 않는다", () => {
    rememberCenterId("b", "acc1");
    expect(readRememberedCenterId("acc2")).toBeNull();
    setPrefAccount("acc2");
    expect(pickInitialCenterId(C("a", "b"))).toBe("a");
    clearRememberedCenter("acc1"); expect(readRememberedCenterId("acc1")).toBeNull();
  });
  it("계정 미확인이면 저장도 복원도 하지 않는다", () => {
    rememberCenterId("b"); expect(window.localStorage.length).toBe(0);
  });
  it("저장소가 던져도 크래시하지 않는다", () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("quota"); };
    try { expect(() => rememberCenterId("b", "acc1")).not.toThrow(); } finally { Storage.prototype.setItem = orig; }
  });
  it("ManagerNav는 기억한 센터 기준으로 권한을 계산하고, 센터 변경 이벤트에 TTL 무시하고 재확인한다", () => {
    const nav = readFileSync("app/components/ManagerNav.tsx", "utf8");
    expect(nav).toContain("pickInitialCenterId(centers)");
    expect(nav).not.toContain("const active = centers[0];");
    expect(nav).toContain("window.addEventListener(CENTER_CHANGED_EVENT, onCenterChanged);");
    expect(nav).toContain("lastCheckRef.current = 0; recheckPermissions();");
  });
  it("센터 변경 시 이벤트 발행", () => {
    let n = 0; const h = () => { n++; }; window.addEventListener("mwhabit:manager-center-changed", h);
    rememberCenterId("b", "acc1"); window.removeEventListener("mwhabit:manager-center-changed", h);
    expect(n).toBe(1);
  });
  it("fetchMyCenters가 계정을 설정하고, 센터 칩을 쓰는 매니저 화면은 모두 pick/remember를 쓴다", () => {
    expect(readFileSync("lib/manager.ts", "utf8")).toContain("setPrefAccount(accountId);");
    for (const f of ["orders", "members", "classes", "settings", "staff", "coupons", "rooms"]) {
      let src: string; try { src = readFileSync(`app/manager/${f}/page.tsx`, "utf8"); } catch { continue; }
      if (src.includes("setCenterId(list[0].id)")) throw new Error(`${f}: 첫 센터 하드코딩`);
    }
  });

  it("같은 탭에서 계정이 바뀌어도(A 선택 후 B) A의 선택이 B에 적용되지 않고, 로그아웃(null)이면 읽기/쓰기 모두 중단", () => {
    setPrefAccount("accA"); rememberCenterId("b");
    setPrefAccount("accB"); expect(pickInitialCenterId(C("a", "b"))).toBe("a");
    rememberCenterId("a"); setPrefAccount("accA"); expect(pickInitialCenterId(C("a", "b"))).toBe("b");
    setPrefAccount(null); expect(pickInitialCenterId(C("a", "b"))).toBe("a"); rememberCenterId("a"); expect(readRememberedCenterId("accA")).toBe("b");
  });
  it("센터 순서가 바뀌어도 선택 id 유지, 권한이 사라진 센터면 폐기 후 첫 센터", () => {
    setPrefAccount("acc1"); rememberCenterId("c");
    expect(pickInitialCenterId(C("a", "b", "c"))).toBe("c"); expect(pickInitialCenterId(C("c", "a", "b"))).toBe("c");
    expect(pickInitialCenterId(C("a", "b"))).toBe("a");
  });
  it("SSR(window 없음)에서도 던지지 않는다", async () => {
    const w = globalThis.window; // @ts-expect-error jsdom window 일시 제거
    delete globalThis.window;
    try { const m = await import("../../lib/managerCenterPref"); expect(() => { m.rememberCenterId("a", "acc"); m.readRememberedCenterId("acc"); m.pickInitialCenterId(C("a")); }).not.toThrow(); }
    finally { globalThis.window = w; }
  });
  it("모든 첫 센터 기본값이 pickInitialCenterId를 쓴다(announcements 포함), 로그아웃 시 계정 해제", () => {
    expect(readFileSync("app/manager/announcements/page.tsx", "utf8")).toContain("centerId ?? pickInitialCenterId(cs)");
    expect(readFileSync("app/manager/announcements/page.tsx", "utf8")).toContain("rememberCenterId(c.id); await reloadList(c.id);");
    expect(readFileSync("app/components/SessionWatcher.tsx", "utf8")).toContain("setPrefAccount(null);");
  });
  it("URL ?center= 가 필요한 화면은 URL이 우선(sales), 오너 전용 화면은 기존 초기 선택 유지(settlement/subscription)", () => {
    expect(readFileSync("app/manager/sales/page.tsx", "utf8")).toContain("list.find((c) => c.id === requestedCenter)?.id ?? pickInitialCenterId(list)!");
    expect(readFileSync("app/manager/subscription/page.tsx", "utf8")).toContain("setCenterId(qsCenterId);");
    expect(readFileSync("app/manager/settlement/page.tsx", "utf8")).toContain("setCenterId(list.find((c) => c.isOwner)!.id)");
    expect(readFileSync("app/manager/staff/permissions/page.tsx", "utf8")).toContain('params.get("center")');
  });
  it("ManagerNav: 조회 중 센터가 바뀌면 끝난 뒤 한 번 더 재확인(pending)", () => {
    const nav = readFileSync("app/components/ManagerNav.tsx", "utf8");
    expect(nav).toContain("pendingRef.current = true; return;");
    expect(nav).toContain("if (pendingRef.current && mountedRef.current)");
  });
  it("hydration 안전: 저장값은 effect/await 이후에만 읽는다(렌더 중 localStorage 접근 없음)", () => {
    const src = readFileSync("lib/managerCenterPref.ts", "utf8");
    expect(src).not.toMatch(/^const .*localStorage/m);
    for (const f of ["orders", "members", "rooms"]) expect(readFileSync(`app/manager/${f}/page.tsx`, "utf8")).toMatch(/useState<string \| null>\(null\)/);
  });
});
