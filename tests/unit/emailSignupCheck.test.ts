/*
  실기기 QA(2026-09-29) — 이메일 회원가입 사전 중복 확인 클라이언트 래퍼.
  실제 네트워크 호출 없이 supabase.functions.invoke를 모킹한다.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invokeMock(...args) } },
}));

import { checkEmailAvailable } from "../../lib/emailSignupCheck";

beforeEach(() => { invokeMock.mockReset(); });

describe("checkEmailAvailable", () => {
  it("available:true → 가입 가능", async () => {
    invokeMock.mockResolvedValue({ data: { available: true }, error: null });
    const res = await checkEmailAvailable("new@example.com");
    expect(res.available).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("check-signup-email", { body: { email: "new@example.com" } });
  });

  it("available:false → 가입 불가 + 일반 안내 문구(어떤 provider와 겹치는지 알려주지 않음)", async () => {
    invokeMock.mockResolvedValue({ data: { available: false }, error: null });
    const res = await checkEmailAvailable("dup@example.com");
    expect(res.available).toBe(false);
    expect(res.reason).toContain("이미 가입된 계정");
    expect(res.reason).not.toMatch(/naver|kakao|google|social|이메일 계정|소셜/i);
  });

  it("함수 오류(네트워크/미배포 등)는 fail-open — 가입 가능으로 간주해 다음 단계를 막지 않는다", async () => {
    invokeMock.mockResolvedValue({ data: null, error: new Error("network down") });
    const res = await checkEmailAvailable("whoever@example.com");
    expect(res.available).toBe(true);
  });

  it("invoke가 throw해도 fail-open", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    const res = await checkEmailAvailable("whoever@example.com");
    expect(res.available).toBe(true);
  });

  it("빈 이메일은 호출 자체를 생략하고 가입 가능으로 처리", async () => {
    const res = await checkEmailAvailable("   ");
    expect(res.available).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("이메일 앞뒤 공백은 trim해서 전달", async () => {
    invokeMock.mockResolvedValue({ data: { available: true }, error: null });
    await checkEmailAvailable("  spaced@example.com  ");
    expect(invokeMock).toHaveBeenCalledWith("check-signup-email", { body: { email: "spaced@example.com" } });
  });
});
