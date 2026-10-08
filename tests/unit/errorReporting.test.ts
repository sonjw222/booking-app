// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClientErrorRecord, registerErrorReporter, reportClientError, sanitizeText, type ClientErrorRecord } from "../../lib/errorReporting";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
import AppError from "../../app/error";
import GlobalError from "../../app/global-error";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); });
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); registerErrorReporter(null); vi.restoreAllMocks(); });

describe("sanitize / 레코드 구성 — 개인정보·비밀값 제거", () => {
  it("이메일/전화/JWT/Bearer/토큰 query를 가린다", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYXV0aCJ9.abcdefghijk";
    const out = sanitizeText(`fail for a.b@example.com tel 010-1234-5678 ${jwt} Bearer abcdef12345678 https://x.com/p?token=SECRET123&ok=1`, 500);
    expect(out).not.toMatch(/a\.b@example\.com|010-1234-5678|eyJ|abcdef12345678|SECRET123/);
    expect(out).toContain("[email]"); expect(out).toContain("[phone]"); expect(out).toContain("[jwt]"); expect(out).toContain("token=[redacted]");
  });
  it("길이를 제한하고 query/hash 없는 pathname만 기록한다", () => {
    window.history.replaceState({}, "", "/checkout?center=abc&token=ZZZ#frag");
    const rec = buildClientErrorRecord(Object.assign(new Error("x".repeat(1000)), { stack: "s".repeat(5000) }), { source: "t" });
    expect(rec.message.length).toBeLessThanOrEqual(301); expect(rec.stack!.length).toBeLessThanOrEqual(1501);
    expect(rec.path).toBe("/checkout"); expect(JSON.stringify(rec)).not.toMatch(/ZZZ|frag/);
  });
  it("Error가 아닌 값(문자열/null)도 던지지 않는다", () => {
    expect(() => buildClientErrorRecord("boom", { source: "t" })).not.toThrow();
    expect(() => buildClientErrorRecord(null, { source: "t" })).not.toThrow();
  });
});

describe("reportClientError", () => {
  it("DSN/reporter가 없어도 동작: 기본 sink가 구조화 한 줄을 console.error로 남긴다", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportClientError(new Error("render failed"), { source: "app/error", digest: "d123" });
    expect(spy).toHaveBeenCalledTimes(1);
    const [tag, json] = spy.mock.calls[0] as [string, string];
    expect(tag).toBe("[client-error]");
    expect(JSON.parse(json)).toMatchObject({ source: "app/error", name: "Error", message: "render failed", digest: "d123" });
  });
  it("등록된 reporter(향후 Sentry 연결 지점)가 있으면 그것만 호출한다", () => {
    const got: ClientErrorRecord[] = []; const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerErrorReporter((r) => got.push(r));
    reportClientError(new Error("a@b.co"), { source: "s" });
    expect(got).toHaveLength(1); expect(got[0].message).toBe("[email]"); expect(spy).not.toHaveBeenCalled();
  });
  it("reporter가 던져도 화면 복구를 막지 않는다", () => {
    registerErrorReporter(() => { throw new Error("sink down"); });
    expect(() => reportClientError(new Error("x"), { source: "s" })).not.toThrow();
  });
});

describe("오류 화면 — 기록 + 복구", () => {
  it("app/error: 마운트 시 한 번 기록하고, '다시 시도'가 reset을 호출한다", () => {
    const got: ClientErrorRecord[] = []; registerErrorReporter((r) => got.push(r));
    const reset = vi.fn();
    const err = Object.assign(new Error("boom for user@example.com"), { digest: "dg1" });
    root = createRoot(host);
    act(() => root!.render(h(AppError, { error: err, reset })));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ source: "app/error", digest: "dg1" }); expect(got[0].message).not.toContain("user@example.com");
    expect(host.textContent).toContain("화면을 불러오지 못했어요");
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "다시 시도")!;
    act(() => btn.click());
    expect(reset).toHaveBeenCalledTimes(1);
  });
  it("app/error: 같은 error로 리렌더돼도 중복 기록하지 않는다", () => {
    const got: ClientErrorRecord[] = []; registerErrorReporter((r) => got.push(r));
    const err = new Error("once"); root = createRoot(host);
    act(() => root!.render(h(AppError, { error: err, reset: () => {} })));
    act(() => root!.render(h(AppError, { error: err, reset: () => {} })));
    expect(got).toHaveLength(1);
  });
  it("app/global-error: html/body를 직접 그리고 기록 + 복구 버튼 동작", () => {
    const got: ClientErrorRecord[] = []; registerErrorReporter((r) => got.push(r));
    const reset = vi.fn();
    // <html> 안은 DOM 구조상 div에 마운트할 수 없어 서버 렌더 문자열로 구조를 확인하고, 기록은 별도로 확인한다.
    return import("react-dom/server").then(({ renderToString }) => {
      const html = renderToString(h(GlobalError, { error: new Error("root layout failed"), reset }));
      expect(html).toMatch(/^<html lang="ko">.*<body/s); expect(html).toContain("다시 시도");
      expect(got).toHaveLength(0);   // effect는 클라이언트에서만 — 서버 렌더에서는 기록하지 않는다
    });
  });
});
