/*
  MockMessageProvider의 실제 동작(콘솔 로그 + 가짜 성공 응답, 비용 추정)만 검증한다.
  DB 호출이 전혀 없으므로(이번 배치 범위 밖) mocking 대상도 없다.
*/
import { describe, expect, it, vi } from "vitest";
import { MockMessageProvider } from "../../lib/messaging/MockMessageProvider";

describe("MockMessageProvider.send", () => {
  it("sms 채널로 짧은 본문을 보내면 SMS 단가(12P)로 성공 응답을 반환한다", async () => {
    const provider = new MockMessageProvider();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await provider.send({ to: "010-0000-0000", content: "짧은 메시지", channel: "sms" });

    expect(result.status).toBe("sent");
    expect(result.cost).toBe(12);
    expect(result.providerMessageId).toContain("mock_sms_");
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("90byte를 넘는 sms 본문은 LMS 단가(37P)로 자동 전환해 흉내낸다", async () => {
    const provider = new MockMessageProvider();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const longContent = "가".repeat(50); // 한글 1자 3byte 가정 시 90byte 초과

    const result = await provider.send({ to: "010-0000-0000", content: longContent, channel: "sms" });

    expect(result.cost).toBe(37);
  });

  it("lms 채널은 본문 길이와 무관하게 항상 LMS 단가(37P)를 반환한다", async () => {
    const provider = new MockMessageProvider();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await provider.send({ to: "010-0000-0000", content: "짧아도 LMS", channel: "lms" });

    expect(result.cost).toBe(37);
  });

  it("alimtalk 채널은 templateCode를 그대로 로그에 남기고 성공 응답을 반환한다", async () => {
    const provider = new MockMessageProvider();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await provider.send({
      to: "010-0000-0000",
      content: "대체발송용 SMS 본문",
      channel: "alimtalk",
      templateCode: "TPL_001",
      templateVariables: { 회원명: "홍길동" },
    });

    expect(result.status).toBe("sent");
    expect(result.providerMessageId).toContain("mock_alimtalk_");
    expect(logSpy).toHaveBeenCalledWith(
      "(Mock) 메시지 발송",
      expect.objectContaining({ templateCode: "TPL_001" })
    );
    logSpy.mockRestore();
  });
});
