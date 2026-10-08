// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useUnsavedChanges } from "../../lib/useUnsavedChanges";
let root: Root;
function Guard({ dirty }: { dirty: boolean }) { useUnsavedChanges(dirty); return null; }
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.replaceChildren(); });
it("prevents leaving dirty content, confirms once, and releases guards after save", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, appConfirm: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) });
  const host = document.createElement("div"), link = document.createElement("a");
  link.href = "/another-manager-page";
  const navigate = vi.fn((e: Event) => e.preventDefault()); link.addEventListener("click", navigate);
  document.body.append(host, link); root = createRoot(host);
  await act(async () => root.render(createElement(Guard, { dirty: true })));
  const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await act(async () => link.click());
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => link.click());
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(globalThis.appConfirm).toHaveBeenCalledTimes(2);
  await act(async () => root.render(createElement(Guard, { dirty: false })));
  const clean = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
});

// 2026-10-07 — 센터 설정/ManagerChrome 연결 정적 계약(이 hook이 실제로 쓰이는지)
import { readFileSync } from "node:fs";
import { join } from "node:path";
it("manager 설정 화면과 ManagerChrome 뒤로가기가 unsaved-changes guard에 연결돼 있다(저장 후 dirty=false면 해제)", () => {
  const settings = readFileSync(join(__dirname, "../../app/manager/settings/page.tsx"), "utf8");
  expect(settings).toContain("useUnsavedChanges(dirty);");
  expect(settings).toMatch(/if \(c\.id !== centerId && await confirmDiscardChanges\(\)\) setCenterId\(c\.id\)/);
  const chrome = readFileSync(join(__dirname, "../../app/components/ManagerChrome.tsx"), "utf8");
  expect(chrome).toContain("if (!(await confirmDiscardChanges())) return;");
  expect(chrome).toContain('router.push("/manager")');
});
