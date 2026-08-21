// UI-003 / ACL-005 / P2-11: 회원가입("센터 운영자")과 마이페이지("내 센터 등록하기") 두 흐름이
// 공유하는 lib/centers.ts의 검증·저장 로직을 검증한다.
// P2-11부터는 centers/manager_centers/center_roles 4단계 클라이언트 호출 대신
// register_center_for_account_safe() 단일 RPC를 호출한다(원자성 확보, add_register_center_for_account_safe_rpc.sql).
import { describe, it, expect, vi, beforeEach } from "vitest";

const uploadBusinessLicenseMock = vi.fn();
vi.mock("../../lib/storage", () => ({
  uploadBusinessLicense: (...args: unknown[]) => uploadBusinessLicenseMock(...args),
}));

const rpcMock = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import { validateCenterRegistrationInput, registerCenterForAccount, type CenterRegistrationInput } from "../../lib/centers";

const VALID_INPUT: CenterRegistrationInput = {
  name: "테스트 센터",
  address: "서울시 강남구",
  phone: "02-1234-5678",
  businessNumber: "123-45-67890",
  licenseFile: null,
  licenseFileName: "license.pdf",
};

describe("validateCenterRegistrationInput()", () => {
  it("returns null when every required field is filled", () => {
    expect(validateCenterRegistrationInput(VALID_INPUT)).toBeNull();
  });

  it.each([
    ["name", "센터 이름을 입력해주세요"],
    ["address", "센터 주소를 입력해주세요"],
    ["phone", "센터 대표번호를 입력해주세요"],
    ["businessNumber", "사업자등록번호를 입력해주세요"],
    ["licenseFileName", "사업자등록증을 첨부해주세요"],
  ] as const)("flags a missing %s", (field, expected) => {
    const input = { ...VALID_INPUT, [field]: "" };
    expect(validateCenterRegistrationInput(input)).toBe(expected);
  });
});

describe("registerCenterForAccount()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockResolvedValue({ data: "center-1", error: null });
    uploadBusinessLicenseMock.mockResolvedValue("uploaded/path.pdf");
  });

  it("throws on invalid input without touching supabase at all (계정/센터 생성 전 검증 — 회원가입 흐름이 부분 상태로 남지 않도록)", async () => {
    await expect(registerCenterForAccount({ ...VALID_INPUT, name: "" })).rejects.toThrow("센터 이름을 입력해주세요");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("uploads the license file when provided and uses the returned path", async () => {
    const file = new File(["x"], "biz.pdf");
    await registerCenterForAccount({ ...VALID_INPUT, licenseFile: file, licenseFileName: "biz.pdf" });
    expect(uploadBusinessLicenseMock).toHaveBeenCalledWith(file);
    const [, rpcArgs] = rpcMock.mock.calls[0];
    expect((rpcArgs as any).p_business_license_url).toBe("uploaded/path.pdf");
  });

  it("calls register_center_for_account_safe with the form fields and returns the new centerId", async () => {
    const { centerId } = await registerCenterForAccount(VALID_INPUT);
    expect(centerId).toBe("center-1");

    expect(rpcMock).toHaveBeenCalledWith("register_center_for_account_safe", {
      p_name: VALID_INPUT.name,
      p_address: VALID_INPUT.address,
      p_phone: VALID_INPUT.phone,
      p_business_number: VALID_INPUT.businessNumber,
      p_business_license_url: VALID_INPUT.licenseFileName,
    });
  });

  it("surfaces the RPC error message instead of continuing silently (예: 사업자등록번호 중복)", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "이미 등록된 사업자등록번호예요" } });
    await expect(registerCenterForAccount(VALID_INPUT)).rejects.toThrow("이미 등록된 사업자등록번호예요");
  });
});
