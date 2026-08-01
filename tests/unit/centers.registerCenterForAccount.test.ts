// UI-003 / ACL-005: 회원가입("센터 운영자")과 마이페이지("내 센터 등록하기") 두 흐름이
// 공유하는 lib/centers.ts의 검증·저장 로직을 검증한다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const uploadBusinessLicenseMock = vi.fn();
vi.mock("../../lib/storage", () => ({
  uploadBusinessLicense: (...args: unknown[]) => uploadBusinessLicenseMock(...args),
}));

const centersInsertMock = vi.fn();
const managerCentersInsertMock = vi.fn();
const managerCentersUpdatePayloadMock = vi.fn(); // update({...}) 호출 인자 기록용
const managerCentersUpdateMock = vi.fn(); // eq().eq() 최종 resolve 값 제어용
const centerRolesSingleMock = vi.fn();

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "centers") {
        return { insert: (...args: unknown[]) => centersInsertMock(...args) };
      }
      if (table === "manager_centers") {
        return {
          insert: (...args: unknown[]) => managerCentersInsertMock(...args),
          update: (payload: unknown) => {
            managerCentersUpdatePayloadMock(payload);
            return { eq: () => ({ eq: (...args: unknown[]) => managerCentersUpdateMock(...args) }) };
          },
        };
      }
      // center_roles
      return { select: () => ({ eq: () => ({ eq: () => ({ single: (...args: unknown[]) => centerRolesSingleMock(...args) }) }) }) };
    },
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
    centersInsertMock.mockResolvedValue({ error: null });
    managerCentersInsertMock.mockResolvedValue({ error: null });
    managerCentersUpdateMock.mockResolvedValue({ error: null });
    centerRolesSingleMock.mockResolvedValue({ data: { id: "role-owner-1" }, error: null });
    uploadBusinessLicenseMock.mockResolvedValue("uploaded/path.pdf");
  });

  it("throws on invalid input without touching supabase at all (계정/센터 생성 전 검증 — 회원가입 흐름이 부분 상태로 남지 않도록)", async () => {
    await expect(registerCenterForAccount("acc-1", { ...VALID_INPUT, name: "" })).rejects.toThrow("센터 이름을 입력해주세요");
    expect(centersInsertMock).not.toHaveBeenCalled();
  });

  it("uploads the license file when provided and uses the returned path", async () => {
    const file = new File(["x"], "biz.pdf");
    await registerCenterForAccount("acc-1", { ...VALID_INPUT, licenseFile: file, licenseFileName: "biz.pdf" });
    expect(uploadBusinessLicenseMock).toHaveBeenCalledWith(file);
    const insertArg = centersInsertMock.mock.calls[0][0];
    expect(insertArg.business_license_url).toBe("uploaded/path.pdf");
  });

  it("creates centers row, an active manager_centers row for the given accountId, and links the owner role", async () => {
    const { centerId } = await registerCenterForAccount("acc-1", VALID_INPUT);
    expect(centerId).toBeTruthy();

    const centerInsertArg = centersInsertMock.mock.calls[0][0];
    expect(centerInsertArg).toMatchObject({
      id: centerId,
      name: VALID_INPUT.name,
      address: VALID_INPUT.address,
      phone: VALID_INPUT.phone,
      business_number: VALID_INPUT.businessNumber,
    });
    // centers.status는 명시적으로 지정하지 않는다 — DB 기본값('pending')이 기존 플랫폼 승인 흐름과 일치해야 함
    expect(centerInsertArg.status).toBeUndefined();

    const mcInsertArg = managerCentersInsertMock.mock.calls[0][0];
    expect(mcInsertArg).toMatchObject({ account_id: "acc-1", center_id: centerId, status: "active" });

    expect(managerCentersUpdatePayloadMock).toHaveBeenCalledWith({ role_id: "role-owner-1" });
  });

  it("surfaces a centers insert error instead of continuing silently", async () => {
    centersInsertMock.mockResolvedValueOnce({ error: { message: "boom" } });
    await expect(registerCenterForAccount("acc-1", VALID_INPUT)).rejects.toThrow("센터 생성 중 문제가 발생했어요: boom");
    expect(managerCentersInsertMock).not.toHaveBeenCalled();
  });

  it("surfaces a manager_centers insert error instead of continuing silently", async () => {
    managerCentersInsertMock.mockResolvedValueOnce({ error: { message: "boom" } });
    await expect(registerCenterForAccount("acc-1", VALID_INPUT)).rejects.toThrow("매니저 연결 중 문제가 발생했어요: boom");
  });

  it("ACL-005: surfaces a missing/failed owner-role lookup instead of silently leaving role_id unset (기존 코드는 이 실패를 무시했었다)", async () => {
    centerRolesSingleMock.mockResolvedValueOnce({ data: null, error: null });
    await expect(registerCenterForAccount("acc-1", VALID_INPUT)).rejects.toThrow("오너 역할 연결 중 문제가 발생했어요");
    expect(managerCentersUpdateMock).not.toHaveBeenCalled();
  });

  it("surfaces a role_id update error instead of continuing silently", async () => {
    managerCentersUpdateMock.mockResolvedValueOnce({ error: { message: "boom" } });
    await expect(registerCenterForAccount("acc-1", VALID_INPUT)).rejects.toThrow("오너 역할 연결 중 문제가 발생했어요: boom");
  });
});
