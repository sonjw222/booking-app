import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { combineGates, resolvePermissionGate } from "../../lib/permissionGate";

const ROOT = path.resolve(__dirname, "../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const KEY = "message.alimtalk.view";
const owner = { isOwner: true }; const staff = { isOwner: false };

describe("resolvePermissionGate — 조회 중·실패는 허용이 아니다(fail-closed)", () => {
  it("센터 미확정·조회 전은 loading", () => {
    expect(resolvePermissionGate(undefined, { status: "idle" }, KEY)).toBe("loading");
    expect(resolvePermissionGate(staff, { status: "idle" }, KEY)).toBe("loading");
    expect(resolvePermissionGate(undefined, { status: "ok", keys: new Set([KEY]) }, KEY)).toBe("loading");
  });
  it("조회 실패는 error(허용 아님)", () => { expect(resolvePermissionGate(staff, { status: "error" }, KEY)).toBe("error"); });
  it("오너는 전권, 직원은 키가 있어야 allowed, 없으면 denied(키를 넓혀 해석하지 않음)", () => {
    expect(resolvePermissionGate(owner, { status: "idle" }, KEY)).toBe("allowed");
    expect(resolvePermissionGate(staff, { status: "ok", keys: new Set([KEY]) }, KEY)).toBe("allowed");
    expect(resolvePermissionGate(staff, { status: "ok", keys: new Set(["message.sms.send", "pass.sales.view"]) }, KEY)).toBe("denied");
    expect(resolvePermissionGate(staff, { status: "ok", keys: new Set(["message.alimtalk"]) }, KEY)).toBe("denied");
  });
});
describe("combineGates — 센터 선택이 없는 화면", () => {
  it("하나라도 allowed 면 allowed, 아니면 loading > error > denied 순", () => {
    expect(combineGates(["denied", "allowed"])).toBe("allowed");
    expect(combineGates(["denied", "loading"])).toBe("loading");
    expect(combineGates(["denied", "error"])).toBe("error");
    expect(combineGates(["denied", "denied"])).toBe("denied");
    expect(combineGates([])).toBe("loading");
  });
});

function walk(dir: string, out: string[] = []): string[] { for (const n of readdirSync(dir)) { const p = path.join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".tsx")) out.push(p); } return out; }
describe("접근 가능한 이름 — button.switch", () => {
  it("모든 switch 버튼은 role=switch + aria-checked + aria-label(또는 aria-labelledby)을 가진다", () => {
    const bad: string[] = [];
    for (const f of walk(path.join(ROOT, "app"))) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!/className=\{`switch |className="switch /.test(l)) return;
        // 같은 JSX 요소의 속성: 현재 줄과 바로 앞 2줄(`<button` 에서 시작하는 줄까지)
        const start = Math.max(0, i - 2); const block = lines.slice(start, i + 1).join(" ");
        const open = block.lastIndexOf("<button"); const el = open >= 0 ? block.slice(open) : block;
        if (!/role="switch"/.test(el) || !/aria-checked=/.test(el) || !/aria-label=|aria-labelledby=/.test(el)) bad.push(`${path.relative(ROOT, f)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
describe("화면 게이트 연결 — 메뉴와 같은 권한 키", () => {
  for (const [file, key] of [["app/manager/alimtalk/send/page.tsx", "message.alimtalk.view"], ["app/manager/alimtalk/rules/page.tsx", "message.alimtalk.view"], ["app/manager/alimtalk/templates/page.tsx", "message.alimtalk.view"], ["app/manager/alimtalk/settings/page.tsx", "message.alimtalk.view"], ["app/manager/alimtalk/page.tsx", "message.alimtalk.view"], ["app/manager/sales/page.tsx", "pass.sales.view"]] as const) {
    it(`${file} 는 ${key} 게이트를 통과해야 본문을 그린다`, () => {
      const s = read(file);
      expect(s).toContain(`"${key}"`); expect(s).toMatch(/PermissionGateShell/); expect(s).toMatch(/gate !== "allowed"|salesGate !== "allowed"/);
    });
  }
  it("메뉴(ManagerNav·manager/page)가 쓰는 키와 일치한다(새 권한 키를 만들지 않는다)", () => {
    expect(read("app/components/ManagerNav.tsx")).toContain('canSee("message.alimtalk.view")');
    expect(read("app/components/ManagerNav.tsx")).toContain('canSee("pass.sales.view")');
  });
});
