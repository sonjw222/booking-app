// @vitest-environment jsdom
//
// UI-002: 회원 리뷰 본문(center_reviews.content) 저장/조회 경로가 SEC-001의
// 공통 sanitizeRichText()를 실제로 거치는지 검증한다. sanitizeRichText()
// 자체의 payload별 동작은 tests/unit/security.test.ts가 이미 전수 검증하므로
// 여기서는 재구현하지 않고 "저장/조회 함수가 실제로 그 결과를 사용하는지"만
// 확인한다(새 sanitizer 없음, 중복 로직 없음).
//
// content는 reply/공지/센터소개와 달리 이번에 처음으로 plain-text 렌더에서
// dangerouslySetInnerHTML 렌더로 전환되므로, 과거에 한 번도 정화된 적 없는
// 기존 데이터를 안전하게 표시하기 위해 읽기 경로에도 sanitizeRichText()를
// 적용했다 — 이 부분도 함께 검증한다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn().mockResolvedValue({ data: { point: 100 }, error: null });
const selectChain = {
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  single: vi.fn().mockResolvedValue({ data: { id: "acc-1" }, error: null }),
};
const fromMock = vi.fn(() => ({
  select: vi.fn(() => selectChain),
}));

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "auth-1" } } }) },
  },
}));

import { writeReview, fetchReviews, myReviewFor, fetchCenterReviewsForManager } from "../../lib/reviews";

describe("writeReview() sanitizes before calling write_review RPC (UI-002)", () => {
  beforeEach(() => {
    rpcMock.mockClear();
    // myProfileId()가 내부적으로 from("accounts")/from("profiles")를 거치므로
    // profiles 조회 체인만 별도로 채워준다.
    fromMock.mockImplementation((table: string) => {
      if (table === "accounts") {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: "acc-1" } }) }) }) };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => ({ limit: () => Promise.resolve({ data: [{ id: "profile-1" }] }) }),
              }),
            }),
          }),
        };
      }
      return { select: vi.fn(() => selectChain) };
    });
  });

  it("strips <script> from the review content", async () => {
    await writeReview("center-1", 5, "좋아요<script>alert(1)</script>!");
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_content).not.toContain("<script");
    expect(params.p_content).toContain("좋아요");
  });

  it("strips <iframe> from the review content", async () => {
    await writeReview("center-1", 5, '설명<iframe src="https://evil.example"></iframe>');
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_content).not.toContain("<iframe");
  });

  it("strips <svg><script> nested inside the review content", async () => {
    await writeReview("center-1", 5, "<svg><script>alert(1)</script></svg>내용");
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_content).not.toMatch(/<svg/i);
    expect(params.p_content).not.toMatch(/<script/i);
    expect(params.p_content).toContain("내용");
  });

  it("strips javascript: URI schemes from the review content", async () => {
    await writeReview("center-1", 5, '<a href="javascript:alert(1)">클릭</a>');
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_content).not.toMatch(/javascript:/i);
  });

  it("strips event handler attributes from the review content", async () => {
    await writeReview("center-1", 5, '<img src=x onerror=alert(1)><div onclick="a()">t</div>');
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_content).not.toMatch(/onerror/i);
    expect(params.p_content).not.toMatch(/onclick/i);
  });

  it("strips background:url(...) from the review content's style", async () => {
    await writeReview("center-1", 5, '<div style="background:url(https://evil.example/x)">좋아요</div>');
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_content).not.toMatch(/background/i);
    expect(params.p_content).not.toMatch(/url\(/i);
    expect(params.p_content).toContain("좋아요");
  });

  it("preserves bold/italic/underline/color/font-size formatting", async () => {
    await writeReview(
      "center-1", 5,
      '<b>정말</b> <i>좋아요</i> <u>!</u> <span style="color:#7B2D3B;font-size:20px">추천</span>'
    );
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_content).toContain("<b>정말</b>");
    expect(params.p_content).toContain("<i>좋아요</i>");
    expect(params.p_content).toContain("<u>!</u>");
    expect(params.p_content).toMatch(/color:\s*#7B2D3B/i);
    expect(params.p_content).toMatch(/font-size:\s*20px/i);
  });

  it("passes rating/centerId through unchanged alongside the sanitized content", async () => {
    await writeReview("center-77", 4, "좋아요");
    const params = rpcMock.mock.calls[0][1];
    expect(params.p_center_id).toBe("center-77");
    expect(params.p_rating).toBe(4);
  });
});

describe("read paths sanitize content for legacy/plain-text safety (UI-002)", () => {
  it("fetchReviews() sanitizes each row's content", async () => {
    fromMock.mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () =>
              Promise.resolve({
                data: [
                  {
                    id: "r1", profile_id: "p1", rating: 5,
                    content: "좋아요<script>alert(1)</script>",
                    photos: null, reply: null, created_at: new Date().toISOString(),
                    profiles: { name: "홍길동", nickname: null },
                  },
                ],
                error: null,
              }),
          }),
        }),
      }),
    });
    const rows = await fetchReviews("center-1");
    expect(rows[0].content).not.toContain("<script");
    expect(rows[0].content).toContain("좋아요");
  });

  it("fetchReviews() leaves plain text without any tag-like sequence fully intact", async () => {
    fromMock.mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () =>
              Promise.resolve({
                data: [
                  {
                    id: "r2", profile_id: "p2", rating: 4,
                    content: "친절하고 시설도 깨끗해요! 5 만점에 5점 드려요.",
                    photos: null, reply: null, created_at: new Date().toISOString(),
                    profiles: { name: "김철수", nickname: null },
                  },
                ],
                error: null,
              }),
          }),
        }),
      }),
    });
    const rows = await fetchReviews("center-1");
    expect(rows[0].content).toBe("친절하고 시설도 깨끗해요! 5 만점에 5점 드려요.");
  });

  it("fetchCenterReviewsForManager() sanitizes each row's content", async () => {
    fromMock.mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          order: () =>
            Promise.resolve({
              data: [
                {
                  id: "r3", profile_id: "p3", rating: 3,
                  content: '<img src=x onerror=alert(1)>별로예요',
                  photos: null, reply: null, replied_at: null,
                  created_at: new Date().toISOString(),
                  profiles: { name: "이영희", nickname: null },
                },
              ],
              error: null,
            }),
        }),
      }),
    });
    const rows = await fetchCenterReviewsForManager("center-1");
    expect(rows[0].content).not.toMatch(/onerror/i);
    expect(rows[0].content).toContain("별로예요");
  });
});
