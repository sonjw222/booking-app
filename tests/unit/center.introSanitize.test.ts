// @vitest-environment jsdom
//
// SEC-003: 센터소개(centers.intro_blocks[].html) 저장 경로가 정규식 기반
// sanitizeHtml()(제거됨) 대신 SEC-001의 공통 sanitizeRichText()를 실제로
// 거치는지 검증한다. sanitizeRichText() 자체의 payload별 동작은
// tests/unit/security.test.ts에서 이미 전수 검증하므로 재구현하지 않는다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const eqMock = vi.fn().mockResolvedValue({ error: null });
const updateMock = vi.fn(() => ({ eq: eqMock }));
const fromMock = vi.fn(() => ({ update: updateMock }));

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import { updateCenterIntro, type IntroBlock } from "../../lib/center";

const baseFields = {
  intro: "",
  address: "",
  phone: "",
  photoUrl: null as string | null,
  sns: "",
  categories: [] as string[],
  latitude: null as number | null,
  longitude: null as number | null,
  payMethods: [] as string[],
  reviewPoint: 1000,
};

function lastUpdatePayload() {
  return updateMock.mock.calls[updateMock.mock.calls.length - 1][0];
}

describe("updateCenterIntro() sanitizes text blocks before saving (SEC-003)", () => {
  beforeEach(() => {
    fromMock.mockClear();
    updateMock.mockClear();
    eqMock.mockClear();
  });

  it("strips <script> from a text block's html", async () => {
    const blocks: IntroBlock[] = [{ type: "text", value: "", html: "안녕<script>alert(1)</script>" }];
    await updateCenterIntro("center-1", { ...baseFields, introBlocks: blocks });
    const payload = lastUpdatePayload();
    expect(payload.intro_blocks[0].html).not.toContain("<script");
    expect(payload.intro_blocks[0].html).toContain("안녕");
  });

  it("strips <iframe> from a text block's html", async () => {
    const blocks: IntroBlock[] = [
      { type: "text", value: "", html: '내용<iframe src="https://evil.example"></iframe>' },
    ];
    await updateCenterIntro("center-1", { ...baseFields, introBlocks: blocks });
    const payload = lastUpdatePayload();
    expect(payload.intro_blocks[0].html).not.toContain("<iframe");
  });

  it("strips <svg><script> nested inside a text block's html", async () => {
    const blocks: IntroBlock[] = [
      { type: "text", value: "", html: "<svg><script>alert(1)</script></svg>본문" },
    ];
    await updateCenterIntro("center-1", { ...baseFields, introBlocks: blocks });
    const payload = lastUpdatePayload();
    expect(payload.intro_blocks[0].html).not.toMatch(/<svg/i);
    expect(payload.intro_blocks[0].html).not.toMatch(/<script/i);
    expect(payload.intro_blocks[0].html).toContain("본문");
  });

  it("strips javascript: URI schemes from a text block's html", async () => {
    const blocks: IntroBlock[] = [
      { type: "text", value: "", html: '<a href="javascript:alert(1)">클릭</a>' },
    ];
    await updateCenterIntro("center-1", { ...baseFields, introBlocks: blocks });
    const payload = lastUpdatePayload();
    expect(payload.intro_blocks[0].html).not.toMatch(/javascript:/i);
  });

  it("preserves existing formatting (bold/italic/underline/color/font-size)", async () => {
    const blocks: IntroBlock[] = [
      {
        type: "text",
        value: "",
        html: '<b>굵게</b> <i>기울임</i> <u>밑줄</u> <span style="color:#2B4C7E;font-size:18px">색깔+크기</span>',
      },
    ];
    await updateCenterIntro("center-1", { ...baseFields, introBlocks: blocks });
    const payload = lastUpdatePayload();
    expect(payload.intro_blocks[0].html).toContain("<b>굵게</b>");
    expect(payload.intro_blocks[0].html).toContain("<i>기울임</i>");
    expect(payload.intro_blocks[0].html).toContain("<u>밑줄</u>");
    expect(payload.intro_blocks[0].html).toMatch(/color:\s*#2B4C7E/i);
    expect(payload.intro_blocks[0].html).toMatch(/font-size:\s*18px/i);
  });

  it("leaves image blocks completely untouched (no regression)", async () => {
    const blocks: IntroBlock[] = [
      { type: "text", value: "", html: "글" },
      { type: "image", value: "center-abc123.jpg" },
    ];
    await updateCenterIntro("center-1", { ...baseFields, introBlocks: blocks });
    const payload = lastUpdatePayload();
    expect(payload.intro_blocks[1]).toEqual({ type: "image", value: "center-abc123.jpg" });
  });

  it("saves centerId and other fields unchanged alongside sanitized blocks", async () => {
    const blocks: IntroBlock[] = [{ type: "text", value: "", html: "본문" }];
    await updateCenterIntro("center-42", {
      ...baseFields,
      intro: "소개",
      address: "서울시",
      phone: "02-1234-5678",
      introBlocks: blocks,
    });
    expect(fromMock).toHaveBeenCalledWith("centers");
    expect(eqMock).toHaveBeenCalledWith("id", "center-42");
    const payload = lastUpdatePayload();
    expect(payload.intro).toBe("소개");
    expect(payload.address).toBe("서울시");
    expect(payload.phone).toBe("02-1234-5678");
  });
});
