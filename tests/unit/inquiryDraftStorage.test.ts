// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { clearInquiryDrafts, readInquiryDrafts, writeInquiryDrafts, INQUIRY_DRAFT_PREFIX } from "../../lib/inquiryDraftStorage";
beforeEach(() => sessionStorage.clear());
it("isolates accounts, omits empty drafts, expires after 24 hours", () => {
  expect(writeInquiryDrafts("a", { t: { text: "초안", photos: [] }, empty: { text: "", photos: [] } })).toBe(true);
  expect(readInquiryDrafts("a")).toEqual({ t: { text: "초안", photos: [] } });
  expect(readInquiryDrafts("b")).toEqual({});
  expect(readInquiryDrafts("a", Date.now() + 86400001)).toEqual({});
});
it("ignores invalid storage and clears only inquiry drafts on logout", () => {
  sessionStorage.setItem(INQUIRY_DRAFT_PREFIX + "a", "invalid");
  sessionStorage.setItem("unrelated", "keep");
  expect(readInquiryDrafts("a")).toEqual({});
  clearInquiryDrafts();
  expect(sessionStorage.getItem(INQUIRY_DRAFT_PREFIX + "a")).toBeNull();
  expect(sessionStorage.getItem("unrelated")).toBe("keep");
});
