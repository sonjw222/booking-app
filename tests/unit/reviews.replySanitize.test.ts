// @vitest-environment jsdom
//
// SEC-002: 리뷰 답변(center_reviews.reply) 저장 경로가 SEC-001의 공통
// sanitizeRichText()를 실제로 거치는지 검증한다. sanitizeRichText() 자체의
// payload별 동작(script/iframe/svg/javascript:/이벤트핸들러 제거, 서식 보존)은
// tests/unit/security.test.ts에서 이미 전수 검증하므로 여기서는 재구현하지
// 않고, "저장 함수가 그 결과를 실제로 RPC 인자에 실어 보내는지"만 확인한다
// (새 sanitizer 없음, 중복 로직 없음).
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null });

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import { replyToReview } from "../../lib/reviews";

describe("replyToReview() sanitizes before calling reply_review RPC (SEC-002)", () => {
  beforeEach(() => {
    rpcMock.mockClear();
  });

  it("strips <script> from the reply body", async () => {
    await replyToReview("review-1", "감사합니다<script>alert(1)</script>!");
    const [name, params] = rpcMock.mock.calls[0];
    expect(name).toBe("reply_review");
    expect(params.p_review_id).toBe("review-1");
    expect(params.p_reply).not.toContain("<script");
    expect(params.p_reply).toContain("감사합니다");
    expect(params.p_reply).toContain("!");
  });

  it("strips <iframe> from the reply body", async () => {
    await replyToReview("review-2", '답변<iframe src="https://evil.example"></iframe>');
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_reply).not.toContain("<iframe");
  });

  it("strips <svg><script> nested inside the reply body", async () => {
    await replyToReview("review-3", "<svg><script>alert(1)</script></svg>내용");
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_reply).not.toMatch(/<svg/i);
    expect(params.p_reply).not.toMatch(/<script/i);
    expect(params.p_reply).toContain("내용");
  });

  it("strips javascript: URI schemes from the reply body", async () => {
    await replyToReview("review-4", '<a href="javascript:alert(1)">클릭</a>');
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_reply).not.toMatch(/javascript:/i);
  });

  it("strips event handler attributes (onerror/onclick/onload) from the reply body", async () => {
    await replyToReview("review-5", '<img src=x onerror=alert(1)><div onclick="alert(2)">a</div>');
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_reply).not.toMatch(/onerror/i);
    expect(params.p_reply).not.toMatch(/onclick/i);
  });

  it("preserves existing formatting (bold/italic/underline/color/font-size)", async () => {
    await replyToReview(
      "review-6",
      '<b>감사</b> <i>합니다</i> <u>!</u> <span style="color:#7B2D3B;font-size:16px">색깔+크기</span>'
    );
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_reply).toContain("<b>감사</b>");
    expect(params.p_reply).toContain("<i>합니다</i>");
    expect(params.p_reply).toContain("<u>!</u>");
    expect(params.p_reply).toMatch(/color:\s*#7B2D3B/i);
    expect(params.p_reply).toMatch(/font-size:\s*16px/i);
  });

  it("still calls the RPC with an empty string when clearing a reply", async () => {
    await replyToReview("review-7", "");
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_reply).toBe("");
  });
});
