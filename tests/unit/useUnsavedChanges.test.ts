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
