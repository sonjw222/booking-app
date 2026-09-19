// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import ConfirmDialog from "../../app/components/ConfirmDialog";

let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.replaceChildren(); });
it("contains keyboard focus, respects busy Escape, and restores the opener", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const opener = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(opener, host); opener.focus();
  root = createRoot(host);
  const cancel = vi.fn();
  const render = (open: boolean, busy = false) => act(async () => root.render(createElement(ConfirmDialog, { open, busy, title: "삭제 확인", onCancel: cancel, onConfirm: vi.fn() })));
  await render(true);
  const buttons = host.querySelectorAll("button");
  expect(document.activeElement).toBe(buttons[0]);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }));
  expect(document.activeElement).toBe(buttons[1]);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
  expect(document.activeElement).toBe(buttons[0]);
  await render(true, true);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(cancel).not.toHaveBeenCalled();
  await render(true);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(cancel).toHaveBeenCalledOnce();
  await render(false);
  expect(document.activeElement).toBe(opener);
});
