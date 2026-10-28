import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

/* 사업장 소재지(자택 주소)의 홈·공개 상품 하단 표시: 환경변수 NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER 가 정확히 "true" 일 때만(기본·Preview·Production 값 없음 = 꺼짐).
   꺼진 빌드의 홈·상품 번들에는 주소 문자열이 없어야 한다(주소 모듈은 서버 라우트·/legal/business·관리자 구독 화면만 import). 값 자체는 출력하지 않는다. */
const src = (f: string) => readFileSync(path.resolve(__dirname, "../..", f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("홈 푸터 사업장 소재지 플래그", () => {
  it("클라이언트 푸터 컴포넌트는 플래그가 정확히 'true' 일 때만 서버에서 값을 받고, 주소 모듈을 import 하지 않는다", () => {
    const c = strip(src("app/components/BusinessAddressLine.tsx"));
    expect(c).toContain('process.env.NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER !== "true"');
    expect(c).not.toMatch(/businessAddress|businessInfo/);
    expect(c).toContain("/api/public/business-address");
  });
  it("API 라우트는 플래그가 켜져 있을 때만 값을 주고 아니면 404(no-store)", async () => {
    const KEY = "NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER"; const saved = process.env[KEY];
    try {
      const { GET } = await import("../../app/api/public/business-address/route");
      for (const v of [undefined, "", "TRUE", "1", "yes", " true", "false"]) { if (v === undefined) delete process.env[KEY]; else process.env[KEY] = v; const r = await GET(); expect(r.status, `값 '${v}'`).toBe(404); expect(await r.text()).toBe(""); }
      process.env[KEY] = "true"; const ok = await GET(); expect(ok.status).toBe(200); const body = (await ok.json()) as { address?: string }; expect(typeof body.address).toBe("string"); expect(body.address!.length).toBeGreaterThan(5);
    } finally { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; }
  });
  it("next.config 가 플래그 기본값을 'false' 로 인라인한다(켜질 때만 'true')", () => {
    const c = src("next.config.ts");
    expect(c).toMatch(/env: \{ NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER: process\.env\.NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER === "true" \? "true" : "false" \}/);
  });
  it("홈·공개 상품 페이지는 주소 모듈/값을 직접 참조하지 않고 컴포넌트만 쓴다", () => {
    for (const f of ["app/page.tsx", "app/products/page.tsx"]) {
      const s = strip(src(f));
      expect(s, f).toContain("<BusinessAddressLine />"); expect(s, f).not.toMatch(/BUSINESS_ADDRESS|businessAddress|BUSINESS_INFO\.address/);
    }
  });
  it("주소 모듈은 허용된 곳(서버 라우트, /legal/business, 관리자 구독 화면)에서만 import 된다 — 새 노출 지점 없음", () => {
    const files = execSync(`grep -rlE "from \\"[^\\"]*businessAddress\\"" app lib components 2>/dev/null || true`, { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }).split("\n").filter(Boolean).sort();
    expect(files).toEqual(["app/api/public/business-address/route.ts", "app/legal/business/page.tsx", "app/manager/subscription/page.tsx"].sort());
  });
  it(".env.local.example 에 플래그가 기본 꺼짐으로 문서화돼 있다", () => {
    expect(src(".env.local.example")).toMatch(/^NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER=false\s*$/m);
  });
});
