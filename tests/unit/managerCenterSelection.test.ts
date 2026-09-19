// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { preferredCenterId } from "../../lib/managerCenterSelection";
beforeEach(() => sessionStorage.clear());
it("restores a saved center only when it belongs to the authorized candidate list", () => {
  sessionStorage.setItem("manager_current_center", "b");
  expect(preferredCenterId([{ id: "a" }, { id: "b" }])).toBe("b");
  expect(preferredCenterId([{ id: "a" }])).toBe("a");
  expect(preferredCenterId([])).toBeNull();
});
