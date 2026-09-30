/*
  lib/members.ts — sendAlimtalkToMembers() 대상별 변수 자동/수동 채움 + 미해결 변수 차단
  (2026-10-01, A-4~A-6). supabase는 이 함수 경로에서 직접 쓰이지 않지만 모듈 로드 시
  lib/supabaseClient를 import하므로(다른 export들이 씀) 기존 관례대로 목(mock) 처리한다
  (tests/unit/orders.updateOrderStatus.test.ts 참고).
*/
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/supabaseClient", () => ({ supabase: {} }));

const sendMock = vi.fn();
vi.mock("../../lib/messaging", () => ({
  getMessageService: () => ({ send: (...args: unknown[]) => sendMock(...args) }),
}));

import { sendAlimtalkToMembers } from "../../lib/members";

describe("sendAlimtalkToMembers()", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ status: "sent" });
  });

  it("전화번호가 없으면 skipped로 세고 발송을 시도하지 않는다(기존 동작 유지)", async () => {
    const result = await sendAlimtalkToMembers([{ name: "번호없음", phone: null }], "안녕하세요", "center-1");
    expect(result.skipped).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("변수가 없는 일반 문구는 회귀 없이 그대로 발송된다", async () => {
    const result = await sendAlimtalkToMembers([{ name: "김모하빗", phone: "010-1111-2222" }], "안녕하세요, 모하빗입니다.", "center-1");
    expect(result.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ to: "010-1111-2222", content: "안녕하세요, 모하빗입니다." }));
  });

  it("[[회원명]]은 대상마다 자동으로 채워져 발송된다(A-4) — centerName 없이도 이름은 채워짐", async () => {
    await sendAlimtalkToMembers(
      [{ name: "김모하빗", phone: "010-1111-2222" }, { name: "박모하빗", phone: "010-3333-4444" }],
      "[[회원명]]님 안녕하세요", "center-1"
    );
    expect(sendMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ content: "김모하빗님 안녕하세요" }));
    expect(sendMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ content: "박모하빗님 안녕하세요" }));
  });

  it("[[센터명]]은 options.centerName으로 채워진다", async () => {
    await sendAlimtalkToMembers(
      [{ name: "김모하빗", phone: "010-1111-2222" }], "[[센터명]] 공지예요", "center-1", undefined,
      { centerName: "모하빗 테스트센터" }
    );
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ content: "모하빗 테스트센터 공지예요" }));
  });

  it("자동으로 알 수 없는 변수([[수업명]])는 commonVariables로 채워야 발송된다(A-5)", async () => {
    await sendAlimtalkToMembers(
      [{ name: "김모하빗", phone: "010-1111-2222" }], "[[회원명]]님, [[수업명]] 예약 완료", "center-1", undefined,
      { commonVariables: { 수업명: "필라테스 기초반" } }
    );
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ content: "김모하빗님, 필라테스 기초반 예약 완료" }));
  });

  it("commonVariables 없이 [[수업명]]이 남아있으면 발송을 시도하지 않고 unresolved로 센다(A-6, 원문 그대로 발송 금지)", async () => {
    const result = await sendAlimtalkToMembers(
      [{ name: "김모하빗", phone: "010-1111-2222" }], "[[회원명]]님, [[수업명]] 예약 완료", "center-1"
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(result.unresolved).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failedNames).toContain("김모하빗");
  });

  it("대상별로 수강권명/잔여횟수도 자동으로 채워진다", async () => {
    await sendAlimtalkToMembers(
      [{ name: "김모하빗", phone: "010-1111-2222", passName: "10회권", remainingCount: 2 }],
      "[[수강권명]] 잔여 [[수강권 잔여횟수]]회 남았어요", "center-1"
    );
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ content: "10회권 잔여 2회 남았어요" }));
  });

  it("벤더가 실패로 응답하면 failed로 센다(회귀 없음)", async () => {
    sendMock.mockResolvedValue({ status: "failed", message: "오류" });
    const result = await sendAlimtalkToMembers([{ name: "김모하빗", phone: "010-1111-2222" }], "안녕하세요", "center-1");
    expect(result.failed).toBe(1);
    expect(result.failedNames).toContain("김모하빗");
  });

  it("templateCode를 그대로 service.send에 전달한다(회귀 없음)", async () => {
    await sendAlimtalkToMembers([{ name: "김모하빗", phone: "010-1111-2222" }], "안녕하세요", "center-1", "TPL_123");
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ templateCode: "TPL_123" }));
  });
});
