import { describe, it, expect } from "vitest";
import { decideBack, defaultBackFallback } from "../../lib/backPolicy";

const base = { overlayOpen: false, dialogOpen: false, isRoot: false, hasBackTarget: true };

describe("decideBack", () => {
  it("열린 시트/모달이 있으면 배경 이동 없이 오버레이만 닫는다 (root 에서도)", () => {
    expect(decideBack({ ...base, overlayOpen: true })).toBe("close-overlay");
    expect(decideBack({ ...base, overlayOpen: true, isRoot: true })).toBe("close-overlay");
  });
  it("확인 대화상자(alertdialog)가 열려 있으면 아무 이동도 하지 않는다", () => {
    expect(decideBack({ ...base, dialogOpen: true, overlayOpen: true })).toBe("blocked-by-dialog");
  });
  it("root 탭 화면은 back 없음", () => {
    expect(decideBack({ ...base, isRoot: true })).toBe("none");
  });
  it("앱 안 이전 화면이 있으면 그 화면으로, 딥링크 첫 진입이면 fallback", () => {
    expect(decideBack(base)).toBe("history-back");
    expect(decideBack({ ...base, hasBackTarget: false })).toBe("fallback");
    expect(decideBack({ ...base, preferFallback: true })).toBe("fallback");
  });
});

describe("defaultBackFallback", () => {
  it("모드별 홈으로", () => {
    expect(defaultBackFallback("/admin/banners")).toBe("/admin");
    expect(defaultBackFallback("/manager/rooms")).toBe("/manager");
    expect(defaultBackFallback("/center/1")).toBe("/");
    expect(defaultBackFallback("/managers")).toBe("/");
  });
});
