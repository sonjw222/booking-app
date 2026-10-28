import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/* 관리자 QA(#239)에서 발견·수정: send-alimtalk 은 "센터 활성 매니저"만 확인해, 알림톡 권한(message.alimtalk.view)이 없는 직원도 직접 호출로 유료 발송을 할 수 있었다.
   Deno 함수라 vitest 로 실행하지 않고, 권한 검사 구조가 유지되는지를 정적으로 고정한다(실동작은 tests/e2e/admin-qa/06-restricted-staff.spec.ts 가 격리 스택에서 확인). */
const read = (f: string) => readFileSync(path.resolve(__dirname, "../..", f), "utf8");
describe("send-alimtalk — 호출자 권한", () => {
  const fn = read("supabase/functions/send-alimtalk/index.ts");
  const body = fn.slice(fn.indexOf("async function isAuthorizedCaller"), fn.indexOf("async function isPlatformAdminCaller"));
  it("센터 활성 매니저 확인 뒤 호출자 JWT 로 message.alimtalk.view 권한을 확인한다(플랫폼 관리자·service_role 은 먼저 통과)", () => {
    expect(body.indexOf("is_platform_admin")).toBeGreaterThan(-1);
    expect(body).toMatch(/rpc\("has_permission", \{ p_center_id: centerId, p_permission: "message\.alimtalk\.view" \}\)/);
    expect(body).toMatch(/return allowed === true;/);
    expect(body.indexOf("SERVICE_ROLE_KEY) return true")).toBeLessThan(body.indexOf("has_permission"));
    expect(body.indexOf("if (account.is_platform_admin) return true")).toBeLessThan(body.indexOf("has_permission"));
  });
  it("화면 진입점(회원 목록·발송 화면)도 같은 권한 키로 막는다", () => {
    expect(read("app/manager/members/page.tsx")).toMatch(/canSendAlimtalk = canDo\("message\.alimtalk\.view"\)/);
    expect(read("app/manager/alimtalk/send/page.tsx")).toContain('"message.alimtalk.view"');
  });
});
