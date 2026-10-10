// 계정 연동(병합) 성공 직후 getMyAccountId 캐시를 폐기해, 합쳐진 계정 id가 바로 반영되게 한다(PERF-050 후속).
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const invalidate = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("../../lib/authAccount", () => ({ invalidateMyAccountIdCache: () => invalidate() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

import { linkAccountsByCode } from "../../lib/accountLinking";

describe("linkAccountsByCode — 계정 id 캐시 폐기", () => {
  beforeEach(() => { rpc.mockReset(); invalidate.mockReset(); });
  it("성공하면 캐시를 폐기한다", async () => {
    rpc.mockResolvedValueOnce({ data: { mergedAccountName: "A" }, error: null });
    await expect(linkAccountsByCode("code")).resolves.toEqual({ mergedAccountName: "A" });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
  it("실패하면 폐기하지 않고 오류를 던진다", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "bad code" } });
    await expect(linkAccountsByCode("x")).rejects.toThrow("bad code");
    expect(invalidate).not.toHaveBeenCalled();
  });
});
