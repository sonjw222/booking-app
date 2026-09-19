import { expect, it } from "vitest";
import { estimateAlimtalkCost } from "../../lib/messageEstimate";
it("uses configured pricing only for an approved alimtalk template", () => {
  expect(estimateAlimtalkCost(12, 17, true)).toBe(204);
  expect(estimateAlimtalkCost(12, 0, true)).toBe(0);
  expect(estimateAlimtalkCost(12, null, true)).toBeNull();
  expect(estimateAlimtalkCost(12, 17, false)).toBeNull();
  expect(estimateAlimtalkCost(12, -1, true)).toBeNull();
  expect(estimateAlimtalkCost(12, NaN, true)).toBeNull();
});
