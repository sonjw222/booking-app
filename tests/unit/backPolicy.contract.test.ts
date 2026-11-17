import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("back policy wiring (source contract)", () => {
  it("NavigationPolicy 가 단일 back 브리지를 설치한다", () => {
    expect(read("app/components/NavigationPolicy.tsx")).toContain("installBackBridge");
  });
  it("Android back 이 같은 브리지를 호출한다", () => {
    expect(read("app/components/CapacitorBootstrap.tsx")).toContain("window.__mwhabitBack");
  });
  it("BackButton/관리자/운영자 헤더가 같은 이동 함수를 쓴다", () => {
    for (const f of ["BackButton", "ManagerChrome", "AdminChrome"]) {
      const src = read(`app/components/${f}.tsx`);
      expect(src).toContain("navigateBack");
      expect(src).toContain("registerScreenBack");
    }
  });
});
