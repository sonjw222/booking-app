import { describe, expect, it, vi } from "vitest";

// rate limit/권한 오류 메시지는 generic이라 그대로 보여주고, 그 외 DB 오류는 접두어를 붙인다.
let rpcError: { code?: string; message: string } | null = null;
vi.mock("../../lib/supabaseClient", () => ({
  supabase: { rpc: async () => ({ data: null, error: rpcError }) },
}));
import { searchAccountsForMember } from "../../lib/members";

describe("searchAccountsForMember 오류 메시지", () => {
  it("rate limit 메시지는 그대로 전달", async () => {
    rpcError = { code: "P0001", message: "검색 요청이 너무 많아요. 잠시 후 다시 시도해주세요" };
    await expect(searchAccountsForMember("c1", "01012345678")).rejects.toThrow("검색 요청이 너무 많아요. 잠시 후 다시 시도해주세요");
  });
  it("권한 메시지는 그대로, 기타 오류는 '검색에 실패했어요' 접두어", async () => {
    rpcError = { message: "회원 등록 권한이 없어요" };
    await expect(searchAccountsForMember("c1", "홍길")).rejects.toThrow("회원 등록 권한이 없어요");
    rpcError = { message: "boom" };
    await expect(searchAccountsForMember("c1", "홍길")).rejects.toThrow("검색에 실패했어요: boom");
  });
});
