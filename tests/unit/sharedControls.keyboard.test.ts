// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConfirmDialog from "../../app/components/ConfirmDialog";
import SegmentedTabs from "../../app/components/SegmentedTabs";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function key(target: EventTarget, value: string, shiftKey = false) {
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); });
}

describe("shared controls keyboard interaction", () => {
  it("keeps focus within confirmation and restores the trigger on close", () => {
    const trigger = document.createElement("button");
    document.body.prepend(trigger);
    trigger.focus();
    const props = { open: true, title: "예약 취소", onCancel: vi.fn(), onConfirm: vi.fn() };
    act(() => root.render(createElement(ConfirmDialog, props)));
    const buttons = host.querySelectorAll("button");
    expect(document.activeElement).toBe(buttons[0]);
    key(document, "Tab", true);
    expect(document.activeElement).toBe(buttons[1]);
    key(document, "Tab");
    expect(document.activeElement).toBe(buttons[0]);
    key(document, "Escape");
    expect(props.onCancel).toHaveBeenCalledOnce();
    act(() => root.render(createElement(ConfirmDialog, { ...props, open: false })));
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps busy confirmation open and focus contained", () => {
    const props = { open: true, busy: true, title: "처리", onCancel: vi.fn(), onConfirm: vi.fn() };
    act(() => root.render(createElement(ConfirmDialog, props)));
    key(document, "Escape");
    key(document, "Tab");
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector('[role="alertdialog"]'));
  });

  it("does not reset focus when a parent rerenders with a new callback", () => {
    const props = { open: true, title: "확인", onCancel: vi.fn(), onConfirm: vi.fn() };
    act(() => root.render(createElement(ConfirmDialog, props)));
    const confirm = host.querySelectorAll("button")[1];
    confirm.focus();
    act(() => root.render(createElement(ConfirmDialog, { ...props, onCancel: vi.fn() })));
    expect(document.activeElement).toBe(confirm);
  });

  it("supports arrows, wrapping and Home/End in segmented tabs", () => {
    const onChange = vi.fn();
    act(() => root.render(createElement(SegmentedTabs, { value: "all", label: "종류", onChange,
      items: [{ value: "all", label: "전체" }, { value: "future", label: "예정" }, { value: "past", label: "지난 예약" }] })));
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(Array.from(tabs).map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    key(tabs[0], "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("past");
    expect(document.activeElement).toBe(tabs[2]);
    key(tabs[2], "Home");
    expect(document.activeElement).toBe(tabs[0]);
    key(tabs[0], "End");
    expect(document.activeElement).toBe(tabs[2]);
    key(tabs[2], "ArrowRight");
    expect(document.activeElement).toBe(tabs[0]);
  });
});
