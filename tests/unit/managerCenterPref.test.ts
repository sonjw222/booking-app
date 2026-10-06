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
});
