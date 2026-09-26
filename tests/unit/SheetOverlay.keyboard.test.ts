// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import SheetOverlay from "../../app/components/SheetOverlay";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 20, height: 20 }] as unknown as DOMRectList);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const key = (key: string, shiftKey = false) => act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })); });
it("labels the dialog, locks scroll, traps Tab, closes on Escape and restores focus", () => {
  const trigger = document.createElement("button"); document.body.prepend(trigger); trigger.focus();
  const close = vi.fn();
  act(() => root.render(createElement(SheetOverlay, { onClick: close }, createElement("div", { className: "sheet" },
    createElement("h2", { className: "sheet-title" }, "프로필 수정"), createElement("button", {}, "취소"), createElement("input", { "aria-label": "이름" }), createElement("button", {}, "저장")))));
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-labelledby")).toBe(host.querySelector("h2")!.id);
  expect(document.activeElement).toBe(dialog); expect(document.body.style.overflow).toBe("hidden");
  key("Tab"); expect(document.activeElement).toBe(host.querySelector("button"));
  key("Tab", true); expect(document.activeElement).toBe(host.querySelectorAll("button")[1]);
  key("Tab"); expect(document.activeElement).toBe(host.querySelector("button"));
  key("Escape"); expect(close).toHaveBeenCalledOnce();
  act(() => root.render(null)); expect(document.activeElement).toBe(trigger); expect(document.body.style.overflow).not.toBe("hidden");
});
it("only dismisses the upper sheet and retains the scroll lock while another remains", () => {
  const first = vi.fn(), second = vi.fn();
  const sheet = (onClick: () => void, name: string) => createElement(SheetOverlay, { onClick, key: name }, createElement("div", { className: "sheet-title" }, name));
  act(() => root.render([sheet(first, "first"), sheet(second, "second")]));
  key("Escape"); expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledOnce();
  act(() => root.render([sheet(first, "first")])); expect(document.body.style.overflow).toBe("hidden");
  key("Escape"); expect(first).toHaveBeenCalledOnce();
});

it("leaves keyboard and focus control to a confirmation dialog above the sheet", () => {
  const close = vi.fn();
  act(() => root.render(createElement(SheetOverlay, { onClick: close }, createElement("button", {}, "저장"))));
  const confirmation = document.createElement("div"); confirmation.setAttribute("role", "alertdialog");
  const cancel = document.createElement("button"); confirmation.append(cancel); document.body.append(confirmation); cancel.focus();
  expect(document.activeElement).toBe(cancel);
  key("Escape"); expect(close).not.toHaveBeenCalled();
  confirmation.remove(); key("Escape"); expect(close).toHaveBeenCalledOnce();
});
