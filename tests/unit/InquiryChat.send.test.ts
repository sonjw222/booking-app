// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("../../lib/inquiries", () => ({
  fetchMessages: async () => [], sendMessage: send, readThread: async () => {},
  subscribeMessages: () => () => {}, mapInquiryMessageRow: vi.fn(),
  uploadInquiryPhoto: vi.fn(), inquiryPhotoUrl: () => "", deleteMessage: vi.fn(),
}));
vi.mock("../../lib/authAccount", () => ({ getMyAccountId: async () => "test-account" }));
import InquiryChat from "../../app/components/InquiryChat";
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.replaceChildren(); send.mockReset(); });
it("does not send during Korean composition and locks duplicate submits", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  let finish!: () => void;
  send.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const draftChange = vi.fn();
  await act(async () => root.render(createElement(InquiryChat, { threadId: "thread", title: "test", onBack() {}, draft: { text: "안녕하세요", photos: [] }, onDraftChange: draftChange })));
  const input = host.querySelector("textarea")!;
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  expect(send).not.toHaveBeenCalled();
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(send).toHaveBeenCalledExactlyOnceWith("thread", "안녕하세요", []);
  expect(input.disabled).toBe(true);
  await act(async () => finish());
  expect(input.value).toBe("");
  expect(draftChange).toHaveBeenLastCalledWith({ text: "", photos: [] });
});
