// ACL-003: 스태프 개인권한 설정 화면(app/manager/staff/permissions)이 URL의
// ?center= 파라미터로 넘어온 센터에 대해 "요청자가 그 센터의 오너인지"를
// 판정하는 데 쓰는 순수 함수 isOwnerOfCenter()를 검증한다.
// (owner allow / non-owner block / 타 센터 URL 조작 block 시나리오)
import { describe, it, expect } from "vitest";
import { isOwnerOfCenter, type ManagedCenter } from "../../lib/manager";

const center = (over: Partial<ManagedCenter>): ManagedCenter => ({
  id: "center-1",
  name: "센터",
  roleName: "매니저",
  isOwner: false,
  status: "active",
  managerCenterId: "mc-1",
  roleId: "role-1",
  ...over,
});

describe("isOwnerOfCenter() (ACL-003)", () => {
  it("returns true when the requester owns the requested center", () => {
    const centers = [center({ id: "center-1", isOwner: true })];
    expect(isOwnerOfCenter(centers, "center-1")).toBe(true);
  });

  it("returns false when the requester manages the center but is not its owner", () => {
    const centers = [center({ id: "center-1", isOwner: false })];
    expect(isOwnerOfCenter(centers, "center-1")).toBe(false);
  });

  it("returns false when the requested centerId isn't in the requester's own center list at all (URL tampering to another center)", () => {
    const centers = [center({ id: "center-1", isOwner: true })];
    expect(isOwnerOfCenter(centers, "someone-elses-center")).toBe(false);
  });

  it("returns false when centerId is missing (malformed URL, matches the existing '잘못된 접근이에요' path)", () => {
    const centers = [center({ id: "center-1", isOwner: true })];
    expect(isOwnerOfCenter(centers, null)).toBe(false);
  });

  it("returns false for an empty center list (account has no active centers at all)", () => {
    expect(isOwnerOfCenter([], "center-1")).toBe(false);
  });
});
